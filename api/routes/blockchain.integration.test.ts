import 'dotenv/config'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { createServer, type Server } from 'node:http'
import { JsonRpcProvider } from 'ethers'
import { PrismaClient } from '@prisma/client'
import type { Express } from 'express'

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) throw new Error('DATABASE_URL is required for isolated blockchain integration tests')
const schema = `tt_chain_test_${randomUUID().replaceAll('-', '')}`
const isolatedUrl = new URL(databaseUrl)
isolatedUrl.searchParams.set('schema', schema)
const cleanupClient = new PrismaClient({ datasources: { db: { url: databaseUrl } } })
const priorEnvironment = new Map(['DATABASE_URL', 'BLOCKCHAIN_RPC_URL', 'BLOCKCHAIN_PRIVATE_KEY', 'TRUSTTRACE_REGISTRY_ADDRESS'].map((key) => [key, process.env[key]]))
let schemaCreated = false
let hardhatNode: ChildProcess | undefined
let provider: JsonRpcProvider | undefined
let app: Express | undefined
let server: Server | undefined
let testPrisma: PrismaClient | undefined
let apiOrigin = ''
let rpcUrl = ''
let registryAddress = ''
let deploymentTransaction = ''

before(async () => {
  const hardhatCli = resolve('node_modules/hardhat/dist/src/cli.js')
  execFileSync(process.execPath, [hardhatCli, 'compile'], { cwd: process.cwd(), env: process.env, stdio: 'ignore' })
  await cleanupClient.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`)
  schemaCreated = true

  const portProbe = createServer()
  await new Promise<void>((resolveListen, reject) => portProbe.listen(0, '127.0.0.1', (error?: Error) => error ? reject(error) : resolveListen()))
  const address = portProbe.address()
  if (!address || typeof address === 'string') throw new Error('Could not allocate a local Hardhat test port')
  const port = address.port
  await new Promise<void>((resolveClose, reject) => portProbe.close((error) => error ? reject(error) : resolveClose()))
  rpcUrl = `http://127.0.0.1:${port}`
  process.env.BLOCKCHAIN_RPC_URL = rpcUrl
  process.env.TRUSTTRACE_REGISTRY_ADDRESS = ''
  delete process.env.BLOCKCHAIN_PRIVATE_KEY
  hardhatNode = spawn(process.execPath, [hardhatCli, 'node', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: process.cwd(), env: process.env, stdio: 'ignore' })
  provider = new JsonRpcProvider(rpcUrl)
  let ready = false
  for (let attempt = 0; attempt < 100 && !ready; attempt += 1) {
    if (hardhatNode.exitCode !== null) throw new Error('Local Hardhat node exited before it became ready')
    try {
      await provider.getNetwork()
      ready = true
    } catch {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
    }
  }
  if (!ready) throw new Error('Local Hardhat node did not become ready')

  const deployOutput = execFileSync(process.execPath, [resolve('node_modules/tsx/dist/cli.mjs'), 'scripts/deploy-registry.ts'], { cwd: process.cwd(), env: process.env, encoding: 'utf8' })
  const deployment = JSON.parse(deployOutput) as { contractAddress: string; chainId: string; transactionHash: string }
  assert.equal(deployment.chainId, '31337')
  registryAddress = deployment.contractAddress
  deploymentTransaction = deployment.transactionHash

  process.env.DATABASE_URL = isolatedUrl.toString()
  process.env.TRUSTTRACE_REGISTRY_ADDRESS = registryAddress
  const modules = await Promise.all([import('../app.js'), import('../lib/prisma.js')])
  app = modules[0].app
  testPrisma = modules[1].prisma
  server = createServer(app)
  await new Promise<void>((resolveListen, reject) => {
    server!.once('error', reject)
    server!.listen(0, '127.0.0.1', resolveListen)
  })
  const apiAddress = server.address()
  if (!apiAddress || typeof apiAddress === 'string') throw new Error('Could not start isolated blockchain API server')
  apiOrigin = `http://127.0.0.1:${apiAddress.port}`
  execFileSync(process.execPath, [resolve('node_modules/prisma/build/index.js'), 'migrate', 'deploy', '--schema', 'prisma/schema.prisma'], {
    cwd: process.cwd(), env: { ...process.env, DATABASE_URL: isolatedUrl.toString() }, stdio: 'ignore',
  })
})

after(async () => {
  if (server?.listening) await new Promise<void>((resolveClose, reject) => server!.close((error) => error ? reject(error) : resolveClose()))
  await testPrisma?.$disconnect()
  if (schemaCreated) await cleanupClient.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
  await cleanupClient.$disconnect()
  await provider?.destroy()
  if (hardhatNode && hardhatNode.exitCode === null) {
    hardhatNode.kill()
    await new Promise<void>((resolveExit) => hardhatNode!.once('exit', () => resolveExit()))
  }
  for (const [key, value] of priorEnvironment) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

type ApiResult = { response: Response; body: Record<string, any> }
async function request(path: string, options: RequestInit = {}): Promise<ApiResult> {
  const response = await fetch(`${apiOrigin}${path}`, { ...options, headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers } })
  return { response, body: response.status === 204 ? {} : await response.json() as Record<string, any> }
}
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` })

async function createUser(label: string) {
  const email = `${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${randomUUID()}@example.invalid`
  const result = await request('/api/auth/register', { method: 'POST', body: JSON.stringify({ fullName: label, email, password: `Q5!${randomUUID()}aA` }) })
  assert.equal(result.response.status, 201)
  return { token: String(result.body.accessToken) }
}

const productPayload = (brandName: string) => ({
  genericName: 'Acetaminophen', brandName, dosageForm: 'Tablet', strength: '500 mg', activeIngredients: 'Acetaminophen',
  pharmaceuticalCategory: 'OTC', prescriptionRequired: false, manufacturer: 'Local Chain Labs', manufacturerLicenseNumber: 'LOCAL-01',
  regulatoryApprovalNumber: 'LOCAL-REG-01', storageConditions: 'Store dry', temperatureRange: '15-25 C', humidityRequirement: 'Below 60%',
  shelfLifeMonths: 24, unit: 'tablet', packSize: 20, packageType: 'Blister pack', countryOfManufacture: 'Canada', description: '',
})

test('local chain anchors traceability hashes, persists receipts, verifies publicly, scopes APIs, and recovers failures', async () => {
  assert.ok(app && testPrisma && provider)
  const owner = await createUser('Blockchain Owner')
  const outsider = await createUser('Blockchain Outsider')
  assert.equal((await request('/api/organizations', { method: 'POST', headers: bearer(owner.token), body: JSON.stringify({ name: 'Blockchain Test Organization' }) })).response.status, 201)
  assert.equal((await request('/api/organizations', { method: 'POST', headers: bearer(outsider.token), body: JSON.stringify({ name: 'Separate Blockchain Organization' }) })).response.status, 201)

  const firstProduct = await request('/api/products', { method: 'POST', headers: bearer(owner.token), body: JSON.stringify(productPayload('Anchored Product')) })
  assert.equal(firstProduct.response.status, 201)
  const firstProductId = String(firstProduct.body.id)
  const pendingProof = await request(`/api/public/verify/${encodeURIComponent(String(firstProduct.body.traceId))}`)
  assert.equal(pendingProof.body.databaseChainVerified, true)
  assert.equal(pendingProof.body.blockchainVerification.status, 'PENDING')

  const { processPendingAnchors } = await import('../services/anchor-worker.js')
  const { TrustTraceBlockchainService } = await import('../services/TrustTraceBlockchainService.js')
  const processed = await processPendingAnchors(new TrustTraceBlockchainService())
  assert.equal(processed.anchored, 1)
  const firstAnchor = await testPrisma.traceabilityAnchor.findFirst({ where: { event: { productId: firstProductId } } })
  assert.ok(firstAnchor)
  assert.equal(firstAnchor.status, 'ANCHORED')
  assert.ok(firstAnchor.transactionHash)
  assert.ok(firstAnchor.blockNumber)
  assert.equal(firstAnchor.contractAddress?.toLowerCase(), registryAddress.toLowerCase())
  assert.equal(firstAnchor.chainId, '31337')
  const verified = await request(`/api/public/verify/${encodeURIComponent(String(firstProduct.body.traceId))}`)
  assert.equal(verified.body.databaseChainVerified, true)
  assert.equal(verified.body.blockchainAnchorVerified, true)
  assert.equal(verified.body.blockchainVerification.status, 'ANCHORED')
  assert.equal(verified.body.blockchainVerification.proofs[0].transactionHash, firstAnchor.transactionHash)

  const status = await request('/api/blockchain/status', { headers: bearer(owner.token) })
  assert.equal(status.response.status, 200)
  assert.equal(status.body.chainId, '31337')
  assert.equal(status.body.contractAddress.toLowerCase(), registryAddress.toLowerCase())
  assert.equal(status.body.counts.ANCHORED, 1)
  assert.equal(Object.hasOwn(status.body, 'rpcUrl'), false)
  const outsiderAnchors = await request('/api/blockchain/anchors', { headers: bearer(outsider.token) })
  assert.equal(outsiderAnchors.response.status, 200)
  assert.equal(outsiderAnchors.body.total, 0)
  assert.equal((await request(`/api/blockchain/anchors/${firstAnchor.id}`, { headers: bearer(outsider.token) })).response.status, 404)

  const secondProduct = await request('/api/products', { method: 'POST', headers: bearer(owner.token), body: JSON.stringify(productPayload('Recovery Product')) })
  assert.equal(secondProduct.response.status, 201)
  const offlineService = new TrustTraceBlockchainService({ rpcUrl: 'http://127.0.0.1:1', privateKey: '', contractAddress: registryAddress })
  const failedAttempt = await processPendingAnchors(offlineService)
  assert.equal(failedAttempt.failed, 1)
  const failedAnchor = await testPrisma.traceabilityAnchor.findFirst({ where: { event: { productId: String(secondProduct.body.id) } } })
  assert.ok(failedAnchor)
  assert.equal(failedAnchor.status, 'ANCHOR_FAILED')
  assert.equal(failedAnchor.failureCode, 'BLOCKCHAIN_RPC_UNAVAILABLE')
  assert.equal(failedAnchor.transactionHash, null)
  const failedPublic = await request(`/api/public/verify/${encodeURIComponent(String(secondProduct.body.traceId))}`)
  assert.equal(failedPublic.body.databaseChainVerified, true)
  assert.equal(failedPublic.body.blockchainVerification.status, 'ANCHOR_FAILED')

  const retried = await request(`/api/blockchain/anchors/${failedAnchor.id}/retry`, { method: 'POST', headers: bearer(owner.token), body: '{}' })
  assert.equal(retried.response.status, 200)
  assert.equal(retried.body.status, 'ANCHORED')
  assert.ok(retried.body.transactionHash)
  assert.ok(retried.body.blockNumber)
  const recoveredPublic = await request(`/api/public/verify/${encodeURIComponent(String(secondProduct.body.traceId))}`)
  assert.equal(recoveredPublic.body.databaseChainVerified, true)
  assert.equal(recoveredPublic.body.blockchainAnchorVerified, true)
  assert.equal(recoveredPublic.body.blockchainVerification.status, 'ANCHORED')
  const retryIsolation = await request(`/api/blockchain/anchors/${failedAnchor.id}/retry`, { method: 'POST', headers: bearer(outsider.token), body: '{}' })
  assert.equal(retryIsolation.response.status, 404)

  const timeline = await request(`/api/traceability/products/${firstProductId}`, { headers: bearer(owner.token) })
  assert.equal(timeline.response.status, 200)
  assert.equal(timeline.body.databaseChainVerified, true)
  const logs = await request('/api/blockchain/anchors', { headers: bearer(owner.token) })
  assert.equal(logs.body.total, 2)
  const responseText = JSON.stringify({ status: status.body, anchors: logs.body, publicProof: recoveredPublic.body })
  assert.equal(responseText.includes('BLOCKCHAIN_PRIVATE_KEY'), false)
  console.log(`LOCAL_E2E_DEPLOYMENT ${JSON.stringify({ contractAddress: registryAddress, chainId: '31337', deploymentTransaction })}`)
})