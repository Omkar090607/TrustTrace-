import { app } from './app.js'
import { prisma } from './lib/prisma.js'
import { ensureAppendOnlyEventHistory } from './lib/database-protection.js'
import { startAnchorWorker } from './services/anchor-worker.js'
import { ensureOrganizationRbac } from './services/organization-rbac.js'

const port = Number(process.env.PORT ?? 4000)
let server: ReturnType<typeof app.listen> | undefined

async function shutdown() {
  if (server) server.close()
  await prisma.$disconnect()
}

async function start() {
  await prisma.$connect()
  await ensureAppendOnlyEventHistory()
  await ensureOrganizationRbac(prisma)
  server = app.listen(port, () => console.info(`TrustTrace API listening on ${port}`))
  startAnchorWorker()
}

void start().catch((error: unknown) => {
  console.error('TrustTrace API failed to start', error)
  process.exitCode = 1
})

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
