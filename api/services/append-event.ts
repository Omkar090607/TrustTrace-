import { randomUUID } from 'node:crypto'
import type { Prisma, PrismaClient } from '@prisma/client'
import { hashEvent } from '../lib/traceability.js'

type EventInput = {
  productId: string
  batchId?: string
  packageId?: string
  actorId?: string
  organizationId?: string
  locationId?: string
  quantity?: number
  metadata?: Prisma.InputJsonValue
  eventType: string
}

export async function appendSupplyChainEvent(client: Prisma.TransactionClient, input: EventInput) {
  await client.$queryRaw`SELECT pg_advisory_xact_lock(7472616365) IS NULL AS locked`
  const previous = await client.supplyChainEvent.findFirst({ orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] })
  const id = randomUUID()
  const timestamp = new Date()
  const createdAt = timestamp
  const eventData = {
    eventId: id,
    eventType: input.eventType,
    productId: input.productId,
    batchId: input.batchId ?? null,
    packageId: input.packageId ?? null,
    actorId: input.actorId ?? null,
    organizationId: input.organizationId ?? null,
    locationId: input.locationId ?? null,
    timestamp: timestamp.toISOString(),
    quantity: input.quantity ?? null,
    metadata: input.metadata ?? {},
    createdAt: createdAt.toISOString(),
  }
  const previousHash = previous?.currentHash ?? null
  const currentHash = hashEvent(eventData, previousHash)

  const event = await client.supplyChainEvent.create({
    data: {
      id,
      eventType: input.eventType,
      productId: input.productId,
      batchId: input.batchId,
      packageId: input.packageId,
      actorId: input.actorId,
      organizationId: input.organizationId,
      locationId: input.locationId,
      timestamp,
      createdAt,
      quantity: input.quantity,
      metadata: input.metadata ?? {},
      previousHash,
      currentHash,
    },
  })
  await client.traceabilityAnchor.create({ data: { eventId: event.id, eventHash: event.currentHash } })
  return event
}
