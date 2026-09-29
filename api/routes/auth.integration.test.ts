import 'dotenv/config'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { createServer, type Server } from 'node:http'
import { PrismaClient } from '@prisma/client'
import type { Express } from 'express'

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) throw new Error('DATABASE_URL is required for isolated auth tests')

const schema = `tt_auth_test_${randomUUID().replaceAll('-', '')}`
const isolatedUrl = new URL(databaseUrl)
isolatedUrl.searchParams.set('schema', schema)
const cleanupClient = new PrismaClient({ datasources: { db: { url: databaseUrl } } })
const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex')

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
    throw new Error('Could not apply the existing migration to the isolated authentication test schema')
  }

  const modules = await Promise.all([import('../app.js'), import('../lib/prisma.js')])
  app = modules[0].app
  testPrisma = modules[1].prisma
  server = createServer(app)
  await new Promise<void>((resolve, reject) => {
    server!.once('error', reject)
    server!.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Could not start isolated auth test server')
  origin = `http://127.0.0.1:${address.port}`
})

after(async () => {
  if (server?.listening) {
    await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()))
  }
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

function refreshCookie(response: Response): string {
  const header = response.headers.get('set-cookie')
  assert.ok(header, 'refresh cookie should be set')
  assert.match(header, /httponly/i)
  assert.match(header, /samesite=strict/i)
  const value = /(?:^|;\s*)tt_refresh=([^;]+)/i.exec(header)?.[1]
  assert.ok(value, 'refresh token should only be issued in the HttpOnly cookie')
  return decodeURIComponent(value)
}

function assertNoRefreshOrPassword(body: Record<string, unknown>, password: string, ...tokens: string[]) {
  const serialized = JSON.stringify(body)
  assert.equal(serialized.includes(password), false, 'password must not appear in a response body')
  assert.equal(Object.hasOwn(body, 'passwordHash'), false, 'password hash must not appear in a response body')
  assert.equal(Object.hasOwn(body, 'refreshToken'), false, 'refresh token must not appear in a response body')
  for (const token of tokens) assert.equal(serialized.includes(token), false, 'refresh token must not appear in a response body')
}

test('authentication registration, login, access, rotation, expiry, and logout', async () => {
  assert.ok(app && testPrisma)
  const email = `auth-${randomUUID()}@example.invalid`
  const password = `V7!${randomUUID()}aA`
  const registrationInput = { fullName: 'Auth Test User', email, password }
  const weakPassword = await request('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ ...registrationInput, email: `weak-${randomUUID()}@example.invalid`, password: 'weak' }),
  })
  assert.equal(weakPassword.response.status, 400)

  const registered = await request('/api/auth/register', { method: 'POST', body: JSON.stringify(registrationInput) })
  assert.equal(registered.response.status, 201)
  assert.equal(registered.body.passwordHash, undefined)
  assert.equal(typeof registered.body.accessToken, 'string')
  const safeUser = registered.body.user as Record<string, unknown>
  assert.deepEqual(Object.keys(safeUser).sort(), ['email', 'fullName', 'id'])
  assertNoRefreshOrPassword(registered.body, password)
  const initialRefresh = refreshCookie(registered.response)

  const duplicate = await request('/api/auth/register', { method: 'POST', body: JSON.stringify(registrationInput) })
  assert.equal(duplicate.response.status, 409)
  assertNoRefreshOrPassword(duplicate.body, password)

  const invalidLogin = await request('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password: `wrong-${randomUUID()}` }),
  })
  assert.equal(invalidLogin.response.status, 401)
  assert.equal(invalidLogin.body.message, 'Email or password is incorrect')

  const validLogin = await request('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) })
  assert.equal(validLogin.response.status, 200)
  assertNoRefreshOrPassword(validLogin.body, password, initialRefresh)
  const loginRefresh = refreshCookie(validLogin.response)

  const missingToken = await request('/api/auth/me')
  assert.equal(missingToken.response.status, 401)
  const malformedToken = await request('/api/auth/me', { headers: { Authorization: 'Bearer not-a-jwt' } })
  assert.equal(malformedToken.response.status, 401)

  const accessToken = String(validLogin.body.accessToken)
  const me = await request('/api/auth/me', { headers: { Authorization: `Bearer ${accessToken}` } })
  assert.equal(me.response.status, 200)
  assert.deepEqual(Object.keys(me.body).sort(), ['email', 'fullName', 'id'])
  assert.equal(JSON.stringify(me.body).includes(accessToken), false)
  assertNoRefreshOrPassword(me.body, password, loginRefresh)

  const firstRefresh = await request('/api/auth/refresh', { method: 'POST', headers: { Cookie: `tt_refresh=${loginRefresh}` } })
  assert.equal(firstRefresh.response.status, 200)
  assertNoRefreshOrPassword(firstRefresh.body, password, loginRefresh)
  const rotatedRefresh = refreshCookie(firstRefresh.response)
  assert.notEqual(rotatedRefresh, loginRefresh)

  const reusedRefresh = await request('/api/auth/refresh', { method: 'POST', headers: { Cookie: `tt_refresh=${loginRefresh}` } })
  assert.equal(reusedRefresh.response.status, 401)
  const oldTokenRecord = await testPrisma.refreshToken.findUnique({ where: { tokenHash: tokenHash(loginRefresh) } })
  assert.ok(oldTokenRecord?.revokedAt, 'rotated refresh token must be revoked')

  const expiredRefresh = randomBytes(48).toString('base64url')
  await testPrisma.refreshToken.create({
    data: { userId: String(safeUser.id), tokenHash: tokenHash(expiredRefresh), expiresAt: new Date(Date.now() - 60_000) },
  })
  const expiredAttempt = await request('/api/auth/refresh', { method: 'POST', headers: { Cookie: `tt_refresh=${expiredRefresh}` } })
  assert.equal(expiredAttempt.response.status, 401)

  const logout = await request('/api/auth/logout', { method: 'POST', headers: { Cookie: `tt_refresh=${rotatedRefresh}` } })
  assert.equal(logout.response.status, 204)
  const loggedOutAttempt = await request('/api/auth/refresh', { method: 'POST', headers: { Cookie: `tt_refresh=${rotatedRefresh}` } })
  assert.equal(loggedOutAttempt.response.status, 401)
  const loggedOutRecord = await testPrisma.refreshToken.findUnique({ where: { tokenHash: tokenHash(rotatedRefresh) } })
  assert.ok(loggedOutRecord?.revokedAt, 'logout must revoke the refresh token')
})
