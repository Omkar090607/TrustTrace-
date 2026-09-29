import { prisma } from '../lib/prisma.js'
import { BlockchainServiceError, TrustTraceBlockchainService } from './TrustTraceBlockchainService.js'

function failureCode(error: unknown) {
  return error instanceof BlockchainServiceError ? error.code : 'BLOCKCHAIN_ANCHOR_FAILED'
}

export async function processPendingAnchors(blockchain = new TrustTraceBlockchainService()) {
  const pending = await prisma.traceabilityAnchor.findMany({
    where: { status: 'PENDING' },
    orderBy: { createdAt: 'asc' },
    take: 10,
    include: { event: { select: { id: true, currentHash: true } } },
  })
  let anchored = 0
  let failed = 0
  const staleAttempt = new Date(Date.now() - 5 * 60_000)
  for (const anchor of pending) {
    const claimed = await prisma.traceabilityAnchor.updateMany({
      where: { id: anchor.id, status: 'PENDING', OR: [{ lastAttemptAt: null }, { lastAttemptAt: { lt: staleAttempt } }] },
      data: { attemptCount: { increment: 1 }, lastAttemptAt: new Date(), failureCode: null },
    })
    if (claimed.count !== 1) continue
    try {
      const result = await blockchain.anchor(anchor.event.currentHash)
      await prisma.traceabilityAnchor.update({
        where: { id: anchor.id },
        data: {
          status: 'ANCHORED', transactionHash: result.transactionHash, blockNumber: result.blockNumber,
          contractAddress: result.contractAddress, chainId: result.chainId, networkName: result.networkName,
          anchoredAt: new Date(), failureCode: null,
        },
      })
      anchored += 1
    } catch (error) {
      const code = failureCode(error)
      await prisma.traceabilityAnchor.update({ where: { id: anchor.id }, data: { status: 'ANCHOR_FAILED', failureCode: code } })
      console.warn('Blockchain anchoring failed', { anchorId: anchor.id, failureCode: code })
      failed += 1
    }
  }
  return { processed: pending.length, anchored, failed }
}

export function startAnchorWorker() {
  const blockchain = new TrustTraceBlockchainService()
  let running = false
  const processPending = async () => {
    if (running) return
    running = true
    try {
      await processPendingAnchors(blockchain)
    } catch {
      console.error('Blockchain anchor worker could not process pending records')
    } finally {
      running = false
    }
  }

  void processPending()
  const interval = setInterval(() => void processPending(), 15_000)
  interval.unref()
  return () => clearInterval(interval)
}
