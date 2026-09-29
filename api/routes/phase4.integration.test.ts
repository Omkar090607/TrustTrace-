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
if (!databaseUrl) throw new Error('DATABASE_URL is required for isolated Phase 4 tests')
const schema = `tt_phase4_test_${randomUUID().replaceAll('-', '')}`
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
  execFileSync(process.execPath, [resolve('node_modules/prisma/build/index.js'), 'migrate', 'deploy', '--schema', 'prisma/schema.prisma'], {
    cwd: process.cwd(), env: { ...process.env, DATABASE_URL: isolatedUrl.toString() }, stdio: 'ignore',
  })
  const modules = await Promise.all([import('../app.js'), import('../lib/prisma.js')])
  app = modules[0].app
  testPrisma = modules[1].prisma
  server = createServer(app)
  await new Promise<void>((resolveListen, reject) => {
    server!.once('error', reject)
    server!.listen(0, '127.0.0.1', resolveListen)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Could not start isolated Phase 4 test server')
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
  const response = await fetch(`${origin}${path}`, { ...options, headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers } })
  return { response, body: response.status === 204 ? {} : await response.json() as Record<string, any> }
}
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` })

async function createUser(label: string) {
  const email = `${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${randomUUID()}@example.invalid`
  const result = await request('/api/auth/register', { method: 'POST', body: JSON.stringify({ fullName: label, email, password: `Q5!${randomUUID()}aA` }) })
  assert.equal(result.response.status, 201)
  return { id: String(result.body.user.id), token: String(result.body.accessToken) }
}

const productPayload = () => ({
  genericName: 'Acetaminophen', brandName: 'Phase Four Product', dosageForm: 'Tablet', strength: '500 mg',
  activeIngredients: 'Acetaminophen', pharmaceuticalCategory: 'OTC', prescriptionRequired: false,
  manufacturer: 'Phase Four Labs', manufacturerLicenseNumber: 'P4-LIC-01', regulatoryApprovalNumber: 'P4-REG-01',
  storageConditions: 'Store dry', temperatureRange: '15-25 C', humidityRequirement: 'Below 60%',
  shelfLifeMonths: 24, unit: 'tablet', packSize: 20, packageType: 'Blister pack', countryOfManufacture: 'Canada', description: '',
})

test('Phase 4 enforces return eligibility, inspection restock, organization isolation, documents, finance, notifications, reports, and audit', async () => {
  assert.ok(app && testPrisma)
  const owner = await createUser('Phase Four Owner')
  const outsider = await createUser('Phase Four Outsider')
  const organization = await request('/api/organizations', { method: 'POST', headers: bearer(owner.token), body: JSON.stringify({ name: 'Phase Four Operations' }) })
  const outsiderOrganization = await request('/api/organizations', { method: 'POST', headers: bearer(outsider.token), body: JSON.stringify({ name: 'Separate Phase Four Organization' }) })
  assert.equal(organization.response.status, 201)
  assert.equal(outsiderOrganization.response.status, 201)

  const product = await request('/api/products', { method: 'POST', headers: bearer(owner.token), body: JSON.stringify(productPayload()) })
  assert.equal(product.response.status, 201)
  const productId = String(product.body.id)
  const dashboardBeforeBatch = await request('/api/dashboard/summary', { headers: bearer(owner.token) })
  assert.equal(dashboardBeforeBatch.response.status, 200)
  assert.equal(dashboardBeforeBatch.body.products, 1)
  assert.equal(dashboardBeforeBatch.body.activeBatches, 0)
  const initialTraceability = await request('/api/traceability', { headers: bearer(owner.token) })
  assert.equal(initialTraceability.response.status, 200)
  assert.equal(initialTraceability.body.events.some((event: { eventType: string }) => event.eventType === 'PRODUCT_CREATED'), true)
  assert.equal(initialTraceability.body.events.every((event: { timestamp: string }, index: number, events: Array<{ timestamp: string }>) => index === 0 || new Date(events[index - 1].timestamp) <= new Date(event.timestamp)), true)
  assert.equal((await request('/api/traceability', { headers: bearer(outsider.token) })).body.events.length, 0)
  const batch = await request('/api/batches', {
    method: 'POST', headers: bearer(owner.token), body: JSON.stringify({ productId, batchNumber: `P4-${randomUUID()}`, manufacturingDate: '2026-01-01', expiryDate: '2028-01-01', quantityManufactured: 10, manufacturingLocation: 'Plant P4', storageLocation: 'Warehouse P4', currency: 'USD' }),
  })
  assert.equal(batch.response.status, 201)
  const batchId = String(batch.body.id)
  assert.equal((await request('/api/dashboard/summary', { headers: bearer(owner.token) })).body.activeBatches, 1)
  assert.equal((await request(`/api/batches/${batchId}/quality-checks`, { method: 'POST', headers: bearer(owner.token), body: JSON.stringify({ result: 'PASS' }) })).response.status, 201)
  assert.equal((await request('/api/inventory/receive', { method: 'POST', headers: bearer(owner.token), body: JSON.stringify({ batchId, locationName: 'Warehouse P4', quantity: 5 }) })).response.status, 201)

  const shipment = await request('/api/shipments', { method: 'POST', headers: bearer(owner.token), body: JSON.stringify({ destination: 'Recipient site', items: [{ batchId, quantity: 5 }] }) })
  assert.equal(shipment.response.status, 201)
  const shipmentId = String(shipment.body.id)
  assert.equal((await request(`/api/shipments/${shipmentId}/dispatch`, { method: 'POST', headers: bearer(owner.token) })).response.status, 200)
  for (const status of ['IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED']) {
    assert.equal((await request(`/api/shipments/${shipmentId}/status`, { method: 'PATCH', headers: bearer(owner.token), body: JSON.stringify({ status }) })).response.status, 200)
  }

  const createdReturn = await request('/api/returns', { method: 'POST', headers: bearer(owner.token), body: JSON.stringify({ shipmentId, reason: 'Damaged outer package', items: [{ batchId, quantity: 3 }] }) })
  assert.equal(createdReturn.response.status, 201)
  const returnId = String(createdReturn.body.id)
  const excessiveReturn = await request('/api/returns', { method: 'POST', headers: bearer(owner.token), body: JSON.stringify({ shipmentId, reason: 'More than delivered balance', items: [{ batchId, quantity: 3 }] }) })
  assert.equal(excessiveReturn.response.status, 409)
  assert.equal((await request(`/api/returns/${returnId}/restock`, { method: 'POST', headers: bearer(owner.token), body: '{}' })).response.status, 409)
  assert.equal((await request(`/api/returns/${returnId}/receive`, { method: 'POST', headers: bearer(owner.token), body: '{}' })).response.status, 200)
  const inventoryAfterReceipt = await request('/api/inventory', { headers: bearer(owner.token) })
  assert.equal(inventoryAfterReceipt.body.items.reduce((sum: number, row: { available: number }) => sum + row.available, 0), 0)
  const returnItemId = String(createdReturn.body.items[0].id)
  assert.equal((await request(`/api/returns/${returnId}/inspect`, { method: 'POST', headers: bearer(owner.token), body: JSON.stringify({ inspections: [{ returnItemId, outcome: 'PASS' }] }) })).response.status, 200)
  assert.equal((await request(`/api/returns/${returnId}/restock`, { method: 'POST', headers: bearer(owner.token), body: '{}' })).response.status, 200)
  const inventory = await request('/api/inventory', { headers: bearer(owner.token) })
  assert.equal(inventory.body.items.reduce((sum: number, row: { available: number }) => sum + row.available, 0), 3)
  assert.equal((await request(`/api/returns/${returnId}`, { headers: bearer(outsider.token) })).response.status, 404)

  const document = await request('/api/documents', {
    method: 'POST', headers: bearer(owner.token),
    body: JSON.stringify({ name: 'Certificate metadata', contentType: 'application/pdf', sizeBytes: 2048, checksum: 'a'.repeat(64), productId, certificate: { certificateNumber: `CERT-${randomUUID()}`, type: 'Certificate of Analysis', issuer: 'P4 Laboratory', isPublic: true } }),
  })
  assert.equal(document.response.status, 201)
  assert.equal(document.body.downloadAvailable, false)
  assert.equal((await request(`/api/documents/${document.body.id}`, { headers: bearer(outsider.token) })).response.status, 404)
  const documentList = await request('/api/documents', { headers: bearer(owner.token) })
  assert.equal(documentList.body.certificates.length, 1)
  assert.equal(Object.hasOwn(documentList.body.certificates[0], 'documentId'), false)
  const productEvents = await request(`/api/traceability/products/${productId}`, { headers: bearer(owner.token) })
  assert.equal((productEvents.body.events as Array<{ eventType: string }>).some((event) => event.eventType === 'CERTIFICATE_REGISTERED'), true)
  assert.equal((await request(`/api/public/verify/${encodeURIComponent(product.body.traceId)}`)).body.certificates.length, 1)

  const invoice = await request('/api/invoices', { method: 'POST', headers: bearer(owner.token), body: JSON.stringify({ currency: 'USD', items: [{ description: 'Delivered goods', quantity: 2, unitPrice: '12.5000' }] }) })
  assert.equal(invoice.response.status, 201)
  assert.equal(invoice.body.total, '25')
  assert.equal((await request(`/api/invoices/${invoice.body.id}`, { headers: bearer(outsider.token) })).response.status, 404)
  assert.equal((await request(`/api/invoices/${invoice.body.id}/issue`, { method: 'POST', headers: bearer(owner.token), body: '{}' })).response.status, 200)
  const payment = await request(`/api/invoices/${invoice.body.id}/payments`, { method: 'POST', headers: bearer(owner.token), body: JSON.stringify({ amount: '10', method: 'BANK_TRANSFER', reference: 'ops-ref-1' }) })
  assert.equal(payment.response.status, 201)
  assert.equal((await request(`/api/invoices/${invoice.body.id}/payments`, { method: 'POST', headers: bearer(owner.token), body: JSON.stringify({ amount: '20', method: 'CASH' }) })).response.status, 409)
  assert.equal((await request(`/api/payments/${payment.body.id}/refunds`, { method: 'POST', headers: bearer(owner.token), body: JSON.stringify({ amount: '4', reason: 'Duplicate line item' }) })).response.status, 201)
  assert.equal((await request('/api/payments', { headers: bearer(owner.token) })).body.total, 1)
  assert.equal((await request('/api/refunds', { headers: bearer(owner.token) })).body.total, 1)
  assert.equal((await request(`/api/payments/${payment.body.id}/refunds`, { method: 'POST', headers: bearer(owner.token), body: JSON.stringify({ amount: '7', reason: 'Over remaining balance' }) })).response.status, 409)

  const unread = await request('/api/notifications/unread-count', { headers: bearer(owner.token) })
  assert.ok(unread.body.unread >= 3)
  assert.equal((await request('/api/notifications/read-all', { method: 'PATCH', headers: bearer(owner.token) })).response.status, 200)
  assert.equal((await request('/api/notifications/unread-count', { headers: bearer(owner.token) })).body.unread, 0)
  assert.equal((await request('/api/notifications', { headers: bearer(outsider.token) })).body.items.length, 0)

  const report = await request('/api/reports/operations', { headers: bearer(owner.token) })
  assert.equal(report.response.status, 200)
  assert.equal(report.body.products, 1)
  assert.equal(report.body.returnsByStatus.some((entry: { status: string; count: number }) => entry.status === 'RESTOCKED' && entry.count === 1), true)
  assert.equal((await request('/api/reports/operations', { headers: bearer(outsider.token) })).body.products, 0)
  const logs = await request('/api/audit-logs', { headers: bearer(owner.token) })
  assert.equal(logs.response.status, 200)
  assert.equal(logs.body.items.some((entry: { action: string }) => entry.action === 'RETURN_RESTOCKED'), true)
  assert.equal(logs.body.items.some((entry: { action: string }) => entry.action === 'REFUND_RECORDED'), true)
  assert.equal(logs.body.items.some((entry: { metadata: Record<string, unknown> }) => JSON.stringify(entry.metadata).includes(owner.token)), false)
})