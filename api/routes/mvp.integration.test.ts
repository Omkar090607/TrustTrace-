import 'dotenv/config'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { createServer, type Server } from 'node:http'
import { PrismaClient } from '@prisma/client'
import type { Express } from 'express'

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) throw new Error('DATABASE_URL is required for isolated MVP tests')
const schema = `tt_mvp_test_${randomUUID().replaceAll('-', '')}`
const isolatedUrl = new URL(databaseUrl)
isolatedUrl.searchParams.set('schema', schema)
const cleanupClient = new PrismaClient({ datasources: { db: { url: databaseUrl } } })
let app: Express | undefined
let server: Server | undefined
let testPrisma: PrismaClient | undefined
let origin = ''
let schemaCreated = false

before(async () => {
  await cleanupClient.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`)
  schemaCreated = true
  process.env.DATABASE_URL = isolatedUrl.toString()
  try {
    execFileSync(process.execPath, [resolve('node_modules/prisma/build/index.js'), 'migrate', 'deploy', '--schema', 'prisma/schema.prisma'], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: isolatedUrl.toString() },
      stdio: 'ignore',
    })
  } catch {
    throw new Error('Could not apply the existing migration to the isolated MVP test schema')
  }
  const modules = await Promise.all([import('../app.js'), import('../lib/prisma.js')])
  app = modules[0].app
  testPrisma = modules[1].prisma
  server = createServer(app)
  await new Promise<void>((resolveListen, reject) => {
    server!.once('error', reject)
    server!.listen(0, '127.0.0.1', resolveListen)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Could not start isolated MVP test server')
  origin = `http://127.0.0.1:${address.port}`
})

after(async () => {
  if (server?.listening) await new Promise<void>((resolveClose, reject) => server!.close((error) => error ? reject(error) : resolveClose()))
  await testPrisma?.$disconnect()
  if (schemaCreated) await cleanupClient.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
  await cleanupClient.$disconnect()
})

type ApiResult = { response: Response; body: Record<string, any> }
async function request(path: string, options: RequestInit = {}): Promise<ApiResult> {
  const response = await fetch(`${origin}${path}`, {
    ...options,
    headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers },
  })
  return { response, body: response.status === 204 ? {} : await response.json() as Record<string, any> }
}
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` })

async function createUser(label: string) {
  const email = `${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${randomUUID()}@example.invalid`
  const result = await request('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ fullName: label, email, password: `Q5!${randomUUID()}aA` }),
  })
  assert.equal(result.response.status, 201)
  return { id: String(result.body.user.id), token: String(result.body.accessToken) }
}

const productPayload = () => ({
  genericName: 'Acetaminophen', brandName: 'MVP Product', dosageForm: 'Tablet', strength: '500 mg',
  activeIngredients: 'Acetaminophen', pharmaceuticalCategory: 'OTC', prescriptionRequired: false,
  manufacturer: 'MVP Therapeutics', manufacturerLicenseNumber: 'MVP-LIC-01', regulatoryApprovalNumber: 'MVP-REG-01',
  storageConditions: 'Store dry', temperatureRange: '15-25 C', humidityRequirement: 'Below 60%',
  shelfLifeMonths: 24, unit: 'tablet', packSize: 20, packageType: 'Blister pack', countryOfManufacture: 'Canada', description: '',
})

async function createBatch(ownerToken: string, productId: string, batchNumber: string, dates?: { manufacturingDate: string; expiryDate: string }) {
  return request('/api/batches', {
    method: 'POST',
    headers: bearer(ownerToken),
    body: JSON.stringify({
      productId,
      batchNumber,
      manufacturingDate: dates?.manufacturingDate ?? '2026-01-01T00:00:00.000Z',
      expiryDate: dates?.expiryDate ?? '2028-01-01T00:00:00.000Z',
      quantityManufactured: 20,
      manufacturingLocation: 'Plant 1',
      storageLocation: 'Warehouse A',
      currency: 'USD',
    }),
  })
}

test('MVP flow enforces batch, quality, inventory, shipment, traceability, and public verification rules', async () => {
  assert.ok(app && testPrisma)
  const owner = await createUser('MVP Owner')
  const outsider = await createUser('MVP Outsider')
  const organization = await request('/api/organizations', { method: 'POST', headers: bearer(owner.token), body: JSON.stringify({ name: 'MVP Test Organization' }) })
  assert.equal(organization.response.status, 201)

  const product = await request('/api/products', { method: 'POST', headers: bearer(owner.token), body: JSON.stringify(productPayload()) })
  assert.equal(product.response.status, 201)
  const productId = String(product.body.id)
  const traceId = String(product.body.traceId)

  const unauthBatch = await request('/api/batches')
  assert.equal(unauthBatch.response.status, 401)
  const outsiderBatch = await request('/api/batches', { headers: bearer(outsider.token) })
  assert.equal(outsiderBatch.response.status, 403)
  const badDates = await createBatch(owner.token, productId, `BAD-${randomUUID()}`, { manufacturingDate: '2028-01-02', expiryDate: '2028-01-01' })
  assert.equal(badDates.response.status, 400)
  const negativeQuantity = await request('/api/batches', {
    method: 'POST', headers: bearer(owner.token), body: JSON.stringify({
      productId, batchNumber: `NEG-${randomUUID()}`, manufacturingDate: '2026-01-01', expiryDate: '2028-01-01',
      quantityManufactured: -1, manufacturingLocation: 'Plant 1',
    }),
  })
  assert.equal(negativeQuantity.response.status, 400)

  const batchResult = await createBatch(owner.token, productId, `BATCH-${randomUUID()}`)
  assert.equal(batchResult.response.status, 201)
  const batchId = String(batchResult.body.id)
  assert.equal(batchResult.body.status, 'MANUFACTURED')
  assert.equal(batchResult.body.qualityStatus, 'PENDING')
  const unapprovedShipment = await request('/api/shipments', {
    method: 'POST', headers: bearer(owner.token), body: JSON.stringify({ destination: 'Test destination', items: [{ batchId, quantity: 1 }] }),
  })
  assert.equal(unapprovedShipment.response.status, 201)
  const unapprovedDispatch = await request(`/api/shipments/${unapprovedShipment.body.id}/dispatch`, { method: 'POST', headers: bearer(owner.token) })
  assert.equal(unapprovedDispatch.response.status, 409)

  const quality = await request(`/api/batches/${batchId}/quality-checks`, {
    method: 'POST', headers: bearer(owner.token), body: JSON.stringify({ result: 'PASS', notes: 'Test pass' }),
  })
  assert.equal(quality.response.status, 201)
  assert.equal(quality.body.status, 'APPROVED')
  const negativeReceipt = await request('/api/inventory/receive', {
    method: 'POST', headers: bearer(owner.token), body: JSON.stringify({ batchId, locationName: 'Warehouse A', quantity: -2 }),
  })
  assert.equal(negativeReceipt.response.status, 400)
  const receiptA = await request('/api/inventory/receive', {
    method: 'POST', headers: bearer(owner.token), body: JSON.stringify({ batchId, locationName: 'Warehouse A', quantity: 8 }),
  })
  assert.equal(receiptA.response.status, 201)
  const receiptB = await request('/api/inventory/receive', {
    method: 'POST', headers: bearer(owner.token), body: JSON.stringify({ batchId, locationName: 'Warehouse B', quantity: 4 }),
  })
  assert.equal(receiptB.response.status, 201)
  const inventoryBeforeTransfer = await request('/api/inventory', { headers: bearer(owner.token) })
  assert.equal(inventoryBeforeTransfer.body.total, 2)
  const transfer = await request('/api/inventory/transfer', {
    method: 'POST', headers: bearer(owner.token), body: JSON.stringify({ batchId, fromLocationId: receiptA.body.locationId, toLocationId: receiptB.body.locationId, quantity: 3 }),
  })
  assert.equal(transfer.response.status, 200)
  const insufficientTransfer = await request('/api/inventory/transfer', {
    method: 'POST', headers: bearer(owner.token), body: JSON.stringify({ batchId, fromLocationId: receiptA.body.locationId, toLocationId: receiptB.body.locationId, quantity: 100 }),
  })
  assert.equal(insufficientTransfer.response.status, 409)

  const oversizedShipment = await request('/api/shipments', {
    method: 'POST', headers: bearer(owner.token), body: JSON.stringify({ destination: 'Insufficient stock test', items: [{ batchId, quantity: 100 }] }),
  })
  assert.equal(oversizedShipment.response.status, 201)
  const oversizedDispatch = await request(`/api/shipments/${oversizedShipment.body.id}/dispatch`, { method: 'POST', headers: bearer(owner.token) })
  assert.equal(oversizedDispatch.response.status, 409)
  const stockAfterRejectedDispatch = await request('/api/inventory', { headers: bearer(owner.token) })
  assert.equal((stockAfterRejectedDispatch.body.items as Array<{ available: number }>).reduce((sum, row) => sum + row.available, 0), 12)

  const shipment = await request('/api/shipments', {
    method: 'POST', headers: bearer(owner.token), body: JSON.stringify({ destination: 'Recipient facility', items: [{ batchId, quantity: 5 }] }),
  })
  assert.equal(shipment.response.status, 201)
  const invalidProgression = await request(`/api/shipments/${shipment.body.id}/status`, {
    method: 'PATCH', headers: bearer(owner.token), body: JSON.stringify({ status: 'IN_TRANSIT' }),
  })
  assert.equal(invalidProgression.response.status, 409)
  const dispatch = await request(`/api/shipments/${shipment.body.id}/dispatch`, { method: 'POST', headers: bearer(owner.token) })
  assert.equal(dispatch.response.status, 200)
  assert.equal(dispatch.body.status, 'DISPATCHED')
  for (const status of ['IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED']) {
    const transition = await request(`/api/shipments/${shipment.body.id}/status`, {
      method: 'PATCH', headers: bearer(owner.token), body: JSON.stringify({ status }),
    })
    assert.equal(transition.response.status, 200)
    assert.equal(transition.body.status, status)
  }
  const batchAfterDelivery = await request(`/api/batches/${batchId}`, { headers: bearer(owner.token) })
  assert.equal(batchAfterDelivery.body.available, 7)
  assert.equal(batchAfterDelivery.body.status, 'IN_WAREHOUSE')

  const batchTimeline = await request(`/api/traceability/batches/${batchId}`, { headers: bearer(owner.token) })
  assert.equal(batchTimeline.response.status, 200)
  assert.equal(batchTimeline.body.databaseChainVerified, true)
  assert.equal(batchTimeline.body.events[0].organizationName, 'MVP Test Organization')
  const eventTypes = (batchTimeline.body.events as Array<{ eventType: string }>).map((event) => event.eventType)
  for (const eventType of ['BATCH_CREATED', 'QUALITY_CHECK', 'APPROVED', 'WAREHOUSE_RECEIVED', 'INVENTORY_TRANSFER', 'DISPATCHED', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED']) {
    assert.equal(eventTypes.includes(eventType), true, `expected ${eventType} in batch timeline`)
  }
  const productTimeline = await request(`/api/traceability/products/${productId}`, { headers: bearer(owner.token) })
  assert.equal(productTimeline.response.status, 200)
  assert.equal(productTimeline.body.databaseChainVerified, true)
  const publicVerification = await request(`/api/public/verify/${encodeURIComponent(traceId)}`)
  assert.equal(publicVerification.response.status, 200)
  assert.equal(publicVerification.body.databaseChainVerified, true)
  assert.equal(publicVerification.body.product.brandName, 'MVP Product')
  assert.equal(publicVerification.body.expired, false)
  assert.equal(Object.hasOwn(publicVerification.body, 'organizationId'), false)
  assert.equal(Object.hasOwn(publicVerification.body.product, 'organizationId'), false)

  const expiryDate = new Date(Date.now() - 86400000).toISOString()
  const expiredBatchResult = await createBatch(owner.token, productId, `EXPIRED-${randomUUID()}`, { manufacturingDate: '2024-01-01T00:00:00.000Z', expiryDate })
  assert.equal(expiredBatchResult.response.status, 201)
  const expiredBatchId = String(expiredBatchResult.body.id)
  await request(`/api/batches/${expiredBatchId}/quality-checks`, { method: 'POST', headers: bearer(owner.token), body: JSON.stringify({ result: 'PASS' }) })
  const expiredShipment = await request('/api/shipments', {
    method: 'POST', headers: bearer(owner.token), body: JSON.stringify({ destination: 'Expired test', items: [{ batchId: expiredBatchId, quantity: 1 }] }),
  })
  await testPrisma.inventory.create({
    data: { batchId: expiredBatchId, locationId: String(expiredBatchResult.body.storageLocationId), onHand: 1, reserved: 0 },
  })
  await testPrisma.batch.update({ where: { id: expiredBatchId }, data: { available: 1, status: 'IN_WAREHOUSE' } })
  const expiredDispatch = await request(`/api/shipments/${expiredShipment.body.id}/dispatch`, { method: 'POST', headers: bearer(owner.token) })
  assert.equal(expiredDispatch.response.status, 409)
  const expiredVerification = await request(`/api/public/verify/${encodeURIComponent(traceId)}`)
  assert.equal(expiredVerification.response.status, 200)
  assert.equal(expiredVerification.body.expired, true)
  assert.equal(expiredVerification.body.verified, false)
  assert.equal(expiredVerification.body.status, 'REVIEW')
})
