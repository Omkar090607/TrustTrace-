import { BlockchainStatus, Prisma } from '@prisma/client'
import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { authenticate, requireOrganization, requireOrganizationPermission } from '../middleware/auth.js'
import { BlockchainServiceError, TrustTraceBlockchainService } from '../services/TrustTraceBlockchainService.js'

export const blockchainRouter = Router()
blockchainRouter.use(authenticate, requireOrganization)

const idSchema = z.string().uuid()
const blockchain = new TrustTraceBlockchainService()
const anchorInclude = { event: { select: { id: true, eventType: true, productId: true, batchId: true, createdAt: true, product: { select: { name: true } }, batch: { select: { batchNumber: true } } } } }

async function audit(client: Prisma.TransactionClient, input: { organizationId: string; actorId: string; action: string; resourceType?: string; resourceId: string; metadata: Prisma.InputJsonValue }) {
  await client.auditLog.create({ data: { ...input, resourceType: input.resourceType ?? 'TraceabilityAnchor' } })
}

function anchorResponse(anchor: Awaited<ReturnType<typeof prisma.traceabilityAnchor.findFirst>> & { event?: { id: string } } | null) {
  if (!anchor) return null
  return {
    id: anchor.id,
    eventId: anchor.eventId,
    eventHash: anchor.eventHash,
    status: anchor.status,
    transactionHash: anchor.transactionHash,
    blockNumber: anchor.blockNumber?.toString() ?? null,
    contractAddress: anchor.contractAddress,
    chainId: anchor.chainId,
    networkName: anchor.networkName,
    failureCode: anchor.failureCode,
    attemptCount: anchor.attemptCount,
    lastAttemptAt: anchor.lastAttemptAt,
    anchoredAt: anchor.anchoredAt,
    createdAt: anchor.createdAt,
    event: 'event' in anchor ? anchor.event : undefined,
  }
}

blockchainRouter.get('/status', requireOrganizationPermission('blockchain:read'), async (request, response) => {
  const organizationId = request.auth!.organizationId
  const [configuration, grouped, recent] = await Promise.all([
    blockchain.getStatus(),
    prisma.traceabilityAnchor.groupBy({ by: ['status'], where: { event: { organizationId } }, _count: { _all: true } }),
    prisma.traceabilityAnchor.findMany({ where: { event: { organizationId } }, orderBy: { createdAt: 'desc' }, take: 8, include: anchorInclude }),
  ])
  const counts = Object.fromEntries(Object.values(BlockchainStatus).map((status) => [status, 0]))
  for (const item of grouped) counts[item.status] = item._count._all
  return response.json({
    enabled: configuration.configured,
    available: configuration.available,
    writeAvailable: configuration.writeAvailable,
    chainId: configuration.chainId,
    networkName: configuration.networkName,
    contractAddress: configuration.contractAddress,
    counts,
    recentAnchors: recent.map((item) => anchorResponse(item)),
  })
})

blockchainRouter.get('/anchors', requireOrganizationPermission('blockchain:read'), async (request, response) => {
  const status = request.query.status ? z.nativeEnum(BlockchainStatus).safeParse(request.query.status) : null
  if (status && !status.success) return response.status(400).json({ message: 'Invalid blockchain anchor status' })
  const items = await prisma.traceabilityAnchor.findMany({
    where: { event: { organizationId: request.auth!.organizationId }, ...(status?.success ? { status: status.data } : {}) },
    orderBy: { createdAt: 'desc' }, take: 100, include: anchorInclude,
  })
  return response.json({ items: items.map((item) => anchorResponse(item)), total: items.length })
})

blockchainRouter.get('/anchors/:id', requireOrganizationPermission('blockchain:read'), async (request, response) => {
  const id = idSchema.safeParse(request.params.id)
  if (!id.success) return response.status(400).json({ message: 'A valid blockchain anchor ID is required' })
  const item = await prisma.traceabilityAnchor.findFirst({ where: { id: id.data, event: { organizationId: request.auth!.organizationId } }, include: anchorInclude })
  if (!item) return response.status(404).json({ message: 'Blockchain anchor not found' })
  return response.json(anchorResponse(item))
})

blockchainRouter.post('/anchors/:id/retry', requireOrganizationPermission('blockchain:retry'), async (request, response) => {
  const id = idSchema.safeParse(request.params.id)
  if (!id.success) return response.status(400).json({ message: 'A valid blockchain anchor ID is required' })
  const existing = await prisma.traceabilityAnchor.findFirst({
    where: { id: id.data, event: { organizationId: request.auth!.organizationId }, status: { in: ['PENDING', 'ANCHOR_FAILED'] } },
    include: { event: { select: { id: true, currentHash: true } } },
  })
  if (!existing) return response.status(404).json({ message: 'Retryable blockchain anchor not found in this organization' })
  const claimed = await prisma.traceabilityAnchor.updateMany({
    where: {
      id: existing.id,
      event: { organizationId: request.auth!.organizationId },
      status: existing.status,
      ...(existing.status === 'PENDING' ? { OR: [{ lastAttemptAt: null }, { lastAttemptAt: { lt: new Date(Date.now() - 5 * 60_000) } }] } : {}),
    },
    data: { status: 'PENDING', attemptCount: { increment: 1 }, lastAttemptAt: new Date(), failureCode: null },
  })
  if (claimed.count !== 1) return response.status(409).json({ message: 'Anchor state changed; refresh and retry' })
  try {
    const result = await blockchain.anchor(existing.event.currentHash)
    const updated = await prisma.$transaction(async (transaction) => {
      const anchor = await transaction.traceabilityAnchor.update({
        where: { id: existing.id },
        data: {
          status: 'ANCHORED', transactionHash: result.transactionHash, blockNumber: result.blockNumber,
          contractAddress: result.contractAddress, chainId: result.chainId, networkName: result.networkName,
          anchoredAt: new Date(), failureCode: null,
        },
      })
      await audit(transaction, {
        organizationId: request.auth!.organizationId, actorId: request.auth!.userId, action: 'BLOCKCHAIN_ANCHOR_RETRIED',
        resourceType: 'TraceabilityAnchor', resourceId: existing.id,
        metadata: { transactionHash: result.transactionHash, blockNumber: result.blockNumber.toString(), chainId: result.chainId },
      })
      return transaction.traceabilityAnchor.findUniqueOrThrow({ where: { id: anchor.id }, include: anchorInclude })
    })
    return response.json(anchorResponse(updated))
  } catch (error) {
    const code = error instanceof BlockchainServiceError ? error.code : 'BLOCKCHAIN_ANCHOR_FAILED'
    const updated = await prisma.$transaction(async (transaction) => {
      const anchor = await transaction.traceabilityAnchor.update({ where: { id: existing.id }, data: { status: 'ANCHOR_FAILED', failureCode: code } })
      await audit(transaction, {
        organizationId: request.auth!.organizationId, actorId: request.auth!.userId, action: 'BLOCKCHAIN_ANCHOR_RETRY_FAILED',
        resourceType: 'TraceabilityAnchor', resourceId: existing.id, metadata: { failureCode: code },
      })
      return transaction.traceabilityAnchor.findUniqueOrThrow({ where: { id: anchor.id }, include: anchorInclude })
    })
    return response.status(503).json({ message: 'Blockchain anchoring is unavailable; the database traceability record remains intact', anchor: anchorResponse(updated) })
  }
})