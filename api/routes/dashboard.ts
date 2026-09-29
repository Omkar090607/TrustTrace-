import { Router } from 'express'
import { prisma } from '../lib/prisma.js'
import { authenticate, requireOrganization, requireOrganizationPermission } from '../middleware/auth.js'
import { eventDataFromRecord } from '../lib/event-data.js'
import { verifyHashChain } from '../lib/traceability.js'

export const dashboardRouter = Router()
dashboardRouter.use(authenticate, requireOrganization, requireOrganizationPermission('report:read'))

dashboardRouter.get('/summary', async (request, response) => {
  const organizationId = request.auth!.organizationId
  const [products, batches, activeBatches, inventory, shipments, returns, payments] = await Promise.all([
    prisma.product.count({ where: { organizationId, domain: 'PHARMACEUTICAL' } }),
    prisma.batch.count({ where: { product: { organizationId, domain: 'PHARMACEUTICAL' } } }),
    prisma.batch.count({ where: { product: { organizationId, domain: 'PHARMACEUTICAL' }, status: { notIn: ['QUARANTINED', 'DELIVERED', 'RETURNED', 'RECALLED', 'EXPIRED', 'DISPOSED', 'DAMAGED'] } } }),
    prisma.inventory.aggregate({ where: { batch: { product: { organizationId, domain: 'PHARMACEUTICAL' } } }, _sum: { onHand: true, reserved: true } }),
    prisma.shipment.count({ where: { organizationId, status: { notIn: ['DELIVERED', 'CANCELLED'] } } }),
    prisma.return.count({ where: { organizationId } }),
    prisma.payment.count({ where: { invoice: { organizationId } } }),
  ])
  const inventoryAvailable = Math.max(0, (inventory._sum.onHand ?? 0) - (inventory._sum.reserved ?? 0))
  return response.json({ products, batches, activeBatches, inventory: inventoryAvailable, shipments, returns, payments })
})

dashboardRouter.get('/activity', async (request, response) => {
  const rows = await prisma.$queryRaw<Array<{ day: Date; events: number; anchors: number }>>`
    SELECT date_trunc('day', event."createdAt") AS day,
      COUNT(*)::int AS events,
      COUNT(*) FILTER (WHERE anchor.status = 'ANCHORED')::int AS anchors
    FROM "SupplyChainEvent" event
    LEFT JOIN "TraceabilityAnchor" anchor ON anchor."eventId" = event.id
    WHERE event."organizationId" = ${request.auth!.organizationId}::uuid
      AND event."createdAt" >= now() - interval '30 days'
    GROUP BY 1
    ORDER BY 1
  `
  return response.json(rows.map((row) => ({ ...row, day: row.day.toISOString() })))
})

dashboardRouter.get('/recent-events', async (request, response) => {
  const items = await prisma.supplyChainEvent.findMany({
    where: { organizationId: request.auth!.organizationId },
    orderBy: { createdAt: 'desc' },
    take: 5,
    include: { product: { select: { name: true, identity: { select: { traceId: true } } } }, anchor: { select: { status: true } } },
  })
  return response.json(items.map((event) => ({
    id: event.id,
    eventType: event.eventType,
    productName: event.product.name,
    traceId: event.product.identity?.traceId ?? '',
    currentHash: event.currentHash,
    blockchainStatus: event.anchor?.status ?? event.blockchainStatus,
    createdAt: event.createdAt,
  })))
})

dashboardRouter.get('/integrity', async (request, response) => {
  const organizationId = request.auth!.organizationId
  const [eventCount, allEvents, anchors, certificateCount, verifiedCertificates] = await Promise.all([
    prisma.supplyChainEvent.count({ where: { organizationId } }),
    prisma.supplyChainEvent.findMany({ orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }),
    prisma.traceabilityAnchor.groupBy({ by: ['status'], where: { event: { organizationId } }, _count: { _all: true } }),
    prisma.certificate.count({ where: { product: { organizationId } } }),
    prisma.certificate.count({ where: { product: { organizationId }, verifiedAt: { not: null } } }),
  ])
  const databaseChainVerified = verifyHashChain(allEvents.map((event) => ({ currentHash: event.currentHash, previousHash: event.previousHash, eventData: eventDataFromRecord(event) })))
  const anchorCounts = Object.fromEntries(anchors.map((entry) => [entry.status, entry._count._all]))
  return response.json({ eventCount, databaseChainVerified, anchors: anchorCounts, certificateCount, verifiedCertificates })
})

dashboardRouter.get('/attention', async (request, response) => {
  const organizationId = request.auth!.organizationId
  const now = new Date()
  const [expiredBatches, expiringBatches, recalledBatches, recalledBatchIds, pendingQualityChecks, activeRecalls, expiringCertificates] = await Promise.all([
    prisma.batch.count({ where: { product: { organizationId }, expiryDate: { lt: now }, status: { notIn: ['RECALLED', 'DISPOSED'] } } }),
    prisma.batch.count({ where: { product: { organizationId }, expiryDate: { gte: now, lte: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000) }, status: { notIn: ['RECALLED', 'EXPIRED', 'DISPOSED', 'DAMAGED'] } } }),
    prisma.batch.findMany({ where: { product: { organizationId }, OR: [{ status: 'RECALLED' }, { recalled: { gt: 0 } }] }, select: { id: true } }),
    prisma.recallItem.findMany({ where: { recall: { organizationId, status: 'ACTIVE' } }, distinct: ['batchId'], select: { batchId: true } }),
    prisma.batch.count({ where: { product: { organizationId }, qualityStatus: 'PENDING' } }),
    prisma.recall.count({ where: { organizationId, status: 'ACTIVE' } }),
    prisma.certificate.count({ where: { product: { organizationId }, expiresAt: { gte: now, lte: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000) } } }),
  ])
  const recalledBatchCount = new Set([...recalledBatches.map((batch) => batch.id), ...recalledBatchIds.map((item) => item.batchId)]).size
  return response.json({ expiredBatches, expiringBatches, recalledBatches: recalledBatchCount, pendingQualityChecks, activeRecalls, expiringCertificates })
})
