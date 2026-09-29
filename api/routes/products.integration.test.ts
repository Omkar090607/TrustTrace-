import 'dotenv/config'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { createServer, type Server } from 'node:http'
import { Prisma, PrismaClient } from '@prisma/client'
import type { Express } from 'express'

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) throw new Error('DATABASE_URL is required for isolated product tests')
const schema = `tt_product_test_${randomUUID().replaceAll('-', '')}`
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
    throw new Error('Could not apply the existing migration to the isolated Product test schema')
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
  if (!address || typeof address === 'string') throw new Error('Could not start isolated Product test server')
  origin = `http://127.0.0.1:${address.port}`
})

after(async () => {
  if (server?.listening) await new Promise<void>((resolveClose, reject) => server!.close((error) => error ? reject(error) : resolveClose()))
  await testPrisma?.$disconnect()
  if (schemaCreated) await cleanupClient.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
  await cleanupClient.$disconnect()
})

type ApiResult = { response: Response; body: Record<string, unknown> }
async function request(path: string, options: RequestInit = {}): Promise<ApiResult> {
  const response = await fetch(`${origin}${path}`, {
    ...options,
    headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers },
  })
  const body = response.status === 204 ? {} : await response.json() as Record<string, unknown>
  return { response, body }
}

async function createUser(label: string) {
  const email = `${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${randomUUID()}@example.invalid`
  const password = `P8!${randomUUID()}aA`
  const result = await request('/api/auth/register', { method: 'POST', body: JSON.stringify({ fullName: label, email, password }) })
  assert.equal(result.response.status, 201)
  return { id: String((result.body.user as Record<string, unknown>).id), email, token: String(result.body.accessToken), password }
}

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` })
const validProduct = () => ({
  genericName: 'Acetaminophen',
  brandName: 'Northstar 500',
  dosageForm: 'Tablet',
  strength: '500 mg',
  activeIngredients: 'Acetaminophen',
  pharmaceuticalCategory: 'OTC',
  prescriptionRequired: false,
  manufacturer: 'Northstar Therapeutics',
  manufacturerLicenseNumber: 'MFG-1001',
  regulatoryApprovalNumber: 'REG-8891',
  storageConditions: 'Store in a dry place',
  temperatureRange: '15-25 C',
  humidityRequirement: 'Below 60 percent',
  shelfLifeMonths: 36,
  unit: 'tablet',
  packSize: 20,
  packageType: 'Blister pack',
  countryOfManufacture: 'Canada',
  description: 'Test-only product in an isolated schema',
})

test('Product API creates, scopes, reads, validates, updates and protects pharmaceutical identities', async () => {
  assert.ok(app && testPrisma)
  const owner = await createUser('Product Owner')
  const member = await createUser('Product Member')
  const outsider = await createUser('Product Outsider')

  const organizationResult = await request('/api/organizations', {
    method: 'POST', headers: bearer(owner.token), body: JSON.stringify({ name: 'Isolated Product Test Organization' }),
  })
  assert.equal(organizationResult.response.status, 201)
  const organizationId = String(organizationResult.body.id)

  const memberResult = await request(`/api/organizations/${organizationId}/members`, {
    method: 'POST', headers: bearer(owner.token), body: JSON.stringify({ email: member.email, roleName: 'MEMBER' }),
  })
  assert.equal(memberResult.response.status, 201)

  const unauthenticated = await request('/api/products')
  assert.equal(unauthenticated.response.status, 401)
  const unauthenticatedCreate = await request('/api/products', { method: 'POST', body: JSON.stringify(validProduct()) })
  assert.equal(unauthenticatedCreate.response.status, 401)

  const invalid = await request('/api/products', {
    method: 'POST', headers: bearer(owner.token), body: JSON.stringify({ ...validProduct(), manufacturerLicenseNumber: '' }),
  })
  assert.equal(invalid.response.status, 400)
  const nonPharmaceutical = await request('/api/products', {
    method: 'POST', headers: bearer(owner.token), body: JSON.stringify({ ...validProduct(), domain: 'electronics' }),
  })
  assert.equal(nonPharmaceutical.response.status, 400)
  const clientTraceId = await request('/api/products', {
    method: 'POST', headers: bearer(owner.token), body: JSON.stringify({ ...validProduct(), traceId: `TT-${randomUUID()}` }),
  })
  assert.equal(clientTraceId.response.status, 400)

  const created = await request('/api/products', {
    method: 'POST', headers: bearer(owner.token), body: JSON.stringify(validProduct()),
  })
  assert.equal(created.response.status, 201)
  const productId = String(created.body.id)
  const traceId = String(created.body.traceId)
  assert.match(traceId, /^TT-[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/)
  assert.equal(created.body.genericName, 'Acetaminophen')
  assert.equal(created.body.domain, 'PHARMACEUTICAL')
  assert.equal(created.body.passwordHash, undefined)
  assert.equal(created.body.refreshToken, undefined)
  assert.equal(JSON.stringify(created.body).includes(owner.password), false)

  const second = await request('/api/products', {
    method: 'POST', headers: bearer(owner.token), body: JSON.stringify({ ...validProduct(), brandName: 'Northstar 500 second pack' }),
  })
  assert.equal(second.response.status, 201)
  assert.notEqual(second.body.traceId, traceId)

  const secondOrganizationResult = await request('/api/organizations', {
    method: 'POST', headers: bearer(owner.token), body: JSON.stringify({ name: 'Second Isolated Product Organization' }),
  })
  assert.equal(secondOrganizationResult.response.status, 201)
  const secondOrganizationId = String(secondOrganizationResult.body.id)
  const secondOrganizationProduct = await request('/api/products', {
    method: 'POST',
    headers: { ...bearer(owner.token), 'X-Organization-Id': secondOrganizationId },
    body: JSON.stringify({ ...validProduct(), brandName: 'Second Organization Product' }),
  })
  assert.equal(secondOrganizationProduct.response.status, 201)
  const firstOrganizationProducts = await request('/api/products', { headers: bearer(owner.token) })
  assert.equal(firstOrganizationProducts.body.total, 2)
  const selectedOrganizationProducts = await request('/api/products', {
    headers: { ...bearer(owner.token), 'X-Organization-Id': secondOrganizationId },
  })
  assert.equal(selectedOrganizationProducts.response.status, 200)
  assert.equal(selectedOrganizationProducts.body.total, 1)
  const forgedOrganization = await request('/api/products', {
    headers: { ...bearer(outsider.token), 'X-Organization-Id': secondOrganizationId },
  })
  assert.equal(forgedOrganization.response.status, 403)

  const memberList = await request('/api/products', { headers: bearer(member.token) })
  assert.equal(memberList.response.status, 200)
  assert.equal(memberList.body.total, 2)
  assert.equal((memberList.body.items as Array<Record<string, unknown>>).some((item) => item.id === productId), true)
  const memberDetail = await request(`/api/products/${productId}`, { headers: bearer(member.token) })
  assert.equal(memberDetail.response.status, 200)
  assert.equal(memberDetail.body.traceId, traceId)

  const outsiderList = await request('/api/products', { headers: bearer(outsider.token) })
  assert.equal(outsiderList.response.status, 403)
  const outsiderDetail = await request(`/api/products/${productId}`, { headers: bearer(outsider.token) })
  assert.equal(outsiderDetail.response.status, 403)

  const memberCreate = await request('/api/products', {
    method: 'POST', headers: bearer(member.token), body: JSON.stringify(validProduct()),
  })
  assert.equal(memberCreate.response.status, 403)
  const memberUpdate = await request(`/api/products/${productId}`, {
    method: 'PATCH', headers: bearer(member.token), body: JSON.stringify({ status: 'INACTIVE' }),
  })
  assert.equal(memberUpdate.response.status, 403)

  const updated = await request(`/api/products/${productId}`, {
    method: 'PATCH', headers: bearer(owner.token), body: JSON.stringify({ brandName: 'Northstar 500 Updated', status: 'INACTIVE' }),
  })
  assert.equal(updated.response.status, 200)
  assert.equal(updated.body.brandName, 'Northstar 500 Updated')
  assert.equal(updated.body.status, 'INACTIVE')
  assert.equal(updated.body.traceId, traceId)
  const missing = await request(`/api/products/${randomUUID()}`, { headers: bearer(owner.token) })
  assert.equal(missing.response.status, 404)
  const clientIdentityUpdate = await request(`/api/products/${productId}`, {
    method: 'PATCH', headers: bearer(owner.token), body: JSON.stringify({ traceId: `TT-${randomUUID()}` }),
  })
  assert.equal(clientIdentityUpdate.response.status, 400)

  const duplicateProduct = await testPrisma.product.create({
    data: {
      productCode: `PH-${randomUUID().slice(0, 8).toUpperCase()}`,
      domain: 'PHARMACEUTICAL',
      organizationId,
      name: 'Identity uniqueness constraint check',
    },
  })
  await assert.rejects(
    testPrisma.productIdentity.create({ data: { productId: duplicateProduct.id, traceId } }),
    (error: unknown) => error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002',
  )
})
