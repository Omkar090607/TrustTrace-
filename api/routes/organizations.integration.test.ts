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
if (!databaseUrl) throw new Error('DATABASE_URL is required for isolated organization tests')
const schema = `tt_org_test_${randomUUID().replaceAll('-', '')}`
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
    throw new Error('Could not apply the existing migration to the isolated organization test schema')
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
  if (!address || typeof address === 'string') throw new Error('Could not start isolated organization test server')
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
  const email = `${label}-${randomUUID()}@example.invalid`
  const password = `T8!${randomUUID()}aA`
  const result = await request('/api/auth/register', { method: 'POST', body: JSON.stringify({ fullName: label, email, password }) })
  assert.equal(result.response.status, 201)
  return { email, token: String(result.body.accessToken), id: String((result.body.user as Record<string, unknown>).id) }
}

function bearer(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` }
}

test('organization membership and RBAC enforce scoped access and role assignments', async () => {
  assert.ok(app && testPrisma)
  const owner = await createUser('Owner')
  const admin = await createUser('Admin')
  const member = await createUser('Member')
  const outsider = await createUser('Outsider')
  const orgResult = await request('/api/organizations', {
    method: 'POST', headers: bearer(owner.token), body: JSON.stringify({ name: 'Isolated auth test org' }),
  })
  assert.equal(orgResult.response.status, 201)
  const organization = orgResult.body
  const organizationId = String(organization.id)
  assert.equal(organization.roleName, 'OWNER')

  const ownerMembership = await testPrisma.organizationMember.findUnique({
    where: { organizationId_userId: { organizationId, userId: owner.id } },
  })
  assert.equal(ownerMembership?.roleName, 'OWNER')
  const rolePermissionCount = await testPrisma.rolePermission.count({
    where: { role: { name: 'OWNER' }, permission: { key: { in: ['organization:read', 'organization:manage', 'member:read', 'member:manage'] } } },
  })
  assert.equal(rolePermissionCount, 4)

  const orgPath = `/api/organizations/${organizationId}`
  const unauthenticated = await request(orgPath)
  assert.equal(unauthenticated.response.status, 401)
  const nonMember = await request(orgPath, { headers: bearer(outsider.token) })
  assert.equal(nonMember.response.status, 403)
  const ownerRead = await request(orgPath, { headers: bearer(owner.token) })
  assert.equal(ownerRead.response.status, 200)
  assert.equal(ownerRead.body.name, 'Isolated auth test org')

  const adminAdded = await request(`${orgPath}/members`, {
    method: 'POST', headers: bearer(owner.token), body: JSON.stringify({ email: admin.email, roleName: 'ADMIN' }),
  })
  assert.equal(adminAdded.response.status, 201)
  assert.equal(adminAdded.body.roleName, 'ADMIN')
  const memberAdded = await request(`${orgPath}/members`, {
    method: 'POST', headers: bearer(owner.token), body: JSON.stringify({ email: member.email, roleName: 'MEMBER' }),
  })
  assert.equal(memberAdded.response.status, 201)
  assert.equal(memberAdded.body.roleName, 'MEMBER')

  const memberRead = await request(orgPath, { headers: bearer(member.token) })
  assert.equal(memberRead.response.status, 200)
  const memberManageDenied = await request(orgPath, { method: 'PATCH', headers: bearer(member.token), body: JSON.stringify({ name: 'Unauthorized rename' }) })
  assert.equal(memberManageDenied.response.status, 403)
  const memberInviteDenied = await request(`${orgPath}/members`, {
    method: 'POST', headers: bearer(member.token), body: JSON.stringify({ email: outsider.email }),
  })
  assert.equal(memberInviteDenied.response.status, 403)
  const memberList = await request(`${orgPath}/members`, { headers: bearer(member.token) })
  assert.equal(memberList.response.status, 200)
  assert.equal((memberList.body.items as unknown[]).length, 3)

  const adminInvite = await request(`${orgPath}/members`, {
    method: 'POST', headers: bearer(admin.token), body: JSON.stringify({ email: outsider.email, roleName: 'MEMBER' }),
  })
  assert.equal(adminInvite.response.status, 201)
  const adminPromotionDenied = await request(`${orgPath}/members/${outsider.id}`, {
    method: 'PATCH', headers: bearer(admin.token), body: JSON.stringify({ roleName: 'ADMIN' }),
  })
  assert.equal(adminPromotionDenied.response.status, 403)
  const adminRemoval = await request(`${orgPath}/members/${outsider.id}`, { method: 'DELETE', headers: bearer(admin.token) })
  assert.equal(adminRemoval.response.status, 204)

  const ownerPromotesMember = await request(`${orgPath}/members/${member.id}`, {
    method: 'PATCH', headers: bearer(owner.token), body: JSON.stringify({ roleName: 'ADMIN' }),
  })
  assert.equal(ownerPromotesMember.response.status, 200)
  assert.equal(ownerPromotesMember.body.roleName, 'ADMIN')
  const promotedAdminManage = await request(orgPath, {
    method: 'PATCH', headers: bearer(member.token), body: JSON.stringify({ name: 'Managed by promoted admin' }),
  })
  assert.equal(promotedAdminManage.response.status, 200)
  assert.equal(promotedAdminManage.body.name, 'Managed by promoted admin')

  const ownerRemovalDenied = await request(`${orgPath}/members/${owner.id}`, { method: 'DELETE', headers: bearer(owner.token) })
  assert.equal(ownerRemovalDenied.response.status, 403)
  const invalidRole = await request(`${orgPath}/members/${outsider.id}`, {
    method: 'PATCH', headers: bearer(owner.token), body: JSON.stringify({ roleName: 'SUPERADMIN' }),
  })
  assert.equal(invalidRole.response.status, 400)
  const organizations = await request('/api/organizations', { headers: bearer(owner.token) })
  assert.equal(organizations.response.status, 200)
  assert.equal((organizations.body.items as unknown[]).length, 1)
})
