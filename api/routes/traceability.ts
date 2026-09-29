import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { eventDataFromRecord } from '../lib/event-data.js'
import { verifyHashChain } from '../lib/traceability.js'
import { authenticate, requireOrganization, requireOrganizationPermission } from '../middleware/auth.js'

export const traceabilityRouter = Router()
traceabilityRouter.use(authenticate, requireOrganization, requireOrganizationPermission('traceability:read'))
const idSchema = z.string().uuid()

async function chainStatus() {
  const allEvents = await prisma.supplyChainEvent.findMany({ orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
  return verifyHashChain(allEvents.map((event) => ({ currentHash: event.currentHash, previousHash: event.previousHash, eventData: eventDataFromRecord(event) })))
}

async function eventTimeline(events: Array<{
  id: string
  eventType: string
  actorId: string | null
  organizationId: string | null
  locationId: string | null
  timestamp: Date
  quantity: number | null
  metadata: unknown
  previousHash: string | null
  currentHash: string
  blockchainStatus: string
  blockchainTransactionHash: string | null
  anchor: { id: string; status: string; transactionHash: string | null; blockNumber: bigint | null; contractAddress: string | null; chainId: string | null; networkName: string | null; failureCode: string | null; attemptCount: number; anchoredAt: Date | null } | null
  product?: { id: string; name: string; identity: { traceId: string } | null }
  batch?: { id: string; batchNumber: string } | null
  actor: { fullName: string } | null
}>, organizationId: string) {
  const locationIds = [...new Set(events.map((event) => event.locationId).filter((id): id is string => Boolean(id)))]
  const [organization, locations] = await Promise.all([
    prisma.organization.findUnique({ where: { id: organizationId }, select: { name: true } }),
    locationIds.length
      ? prisma.inventoryLocation.findMany({ where: { id: { in: locationIds }, organizationId }, select: { id: true, name: true } })
      : Promise.resolve([]),
  ])
  const locationNames = new Map(locations.map((location) => [location.id, location.name]))
  return events.map((event) => ({
    eventId: event.id,
    eventType: event.eventType,
    timestamp: event.timestamp,
    actorName: event.actor?.fullName ?? null,
    organizationName: organization?.name ?? 'Organization',
    locationName: event.locationId ? locationNames.get(event.locationId) ?? null : null,
    quantity: event.quantity,
    metadata: event.metadata,
    previousHash: event.previousHash,
    currentHash: event.currentHash,
    blockchainStatus: event.anchor?.status ?? event.blockchainStatus,
    blockchainTransactionHash: event.anchor?.transactionHash ?? event.blockchainTransactionHash,
    anchor: event.anchor ? { ...event.anchor, blockNumber: event.anchor.blockNumber?.toString() ?? null } : null,
    productId: event.product?.id ?? null,
    productName: event.product?.name ?? null,
    traceId: event.product?.identity?.traceId ?? null,
    batchId: event.batch?.id ?? null,
    batchNumber: event.batch?.batchNumber ?? null,
  }))
}

traceabilityRouter.get('/', async (request, response) => {
  const events = await prisma.supplyChainEvent.findMany({
    where: { organizationId: request.auth!.organizationId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: 100,
    include: {
      actor: { select: { fullName: true } },
      anchor: { select: { id: true, status: true, transactionHash: true, blockNumber: true, contractAddress: true, chainId: true, networkName: true, failureCode: true, attemptCount: true, anchoredAt: true } },
      product: { select: { id: true, name: true, identity: { select: { traceId: true } } } },
      batch: { select: { id: true, batchNumber: true } },
    },
  })
  const chronologicalEvents = [...events].reverse()
  return response.json({ databaseChainVerified: await chainStatus(), events: await eventTimeline(chronologicalEvents, request.auth!.organizationId) })
})

traceabilityRouter.get('/products/:id', async (request, response) => {
  const id = idSchema.safeParse(request.params.id)
  if (!id.success) return response.status(400).json({ message: 'A valid product ID is required' })
  const product = await prisma.product.findFirst({
    where: { id: id.data, organizationId: request.auth!.organizationId, domain: 'PHARMACEUTICAL' },
    select: { id: true, name: true, identity: { select: { traceId: true } } },
  })
  if (!product) return response.status(404).json({ message: 'Product not found' })
  const allProductEvents = await prisma.supplyChainEvent.findMany({
    where: { productId: product.id, organizationId: request.auth!.organizationId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    include: { actor: { select: { fullName: true } }, anchor: { select: { id: true, status: true, transactionHash: true, blockNumber: true, contractAddress: true, chainId: true, networkName: true, failureCode: true, attemptCount: true, anchoredAt: true } } },
  })
  return response.json({
    databaseChainVerified: await chainStatus(),
    product: { id: product.id, name: product.name, traceId: product.identity?.traceId ?? null },
    events: await eventTimeline(allProductEvents, request.auth!.organizationId),
  })
})

traceabilityRouter.get('/batches/:id', async (request, response) => {
  const id = idSchema.safeParse(request.params.id)
  if (!id.success) return response.status(400).json({ message: 'A valid batch ID is required' })
  const batch = await prisma.batch.findFirst({
    where: { id: id.data, product: { organizationId: request.auth!.organizationId, domain: 'PHARMACEUTICAL' } },
    select: { id: true, batchNumber: true, productId: true, product: { select: { name: true } } },
  })
  if (!batch) return response.status(404).json({ message: 'Batch not found' })
  const events = await prisma.supplyChainEvent.findMany({
    where: {
      productId: batch.productId,
      organizationId: request.auth!.organizationId,
      OR: [{ batchId: null }, { batchId: batch.id }],
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    include: { actor: { select: { fullName: true } }, anchor: { select: { id: true, status: true, transactionHash: true, blockNumber: true, contractAddress: true, chainId: true, networkName: true, failureCode: true, attemptCount: true, anchoredAt: true } } },
  })
  return response.json({
    databaseChainVerified: await chainStatus(),
    batch: { id: batch.id, batchNumber: batch.batchNumber, productName: batch.product.name },
    events: await eventTimeline(events, request.auth!.organizationId),
  })
})
