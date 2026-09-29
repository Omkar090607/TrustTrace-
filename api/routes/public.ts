import { Router } from 'express'
import { prisma } from '../lib/prisma.js'
import { eventDataFromRecord } from '../lib/event-data.js'
import { verifyHashChain } from '../lib/traceability.js'
import { TrustTraceBlockchainService } from '../services/TrustTraceBlockchainService.js'

export const publicRouter = Router()
const blockchain = new TrustTraceBlockchainService()

publicRouter.get('/verify/:traceId', async (request, response) => {
  const traceId = String(request.params.traceId)
  const publicCertificateSelect = { id: true, certificateNumber: true, type: true, issuer: true, issuedAt: true, expiresAt: true, verifiedAt: true, status: true } as const
  const identity = await prisma.productIdentity.findUnique({ where: { traceId }, include: { product: { include: { certificates: { where: { isPublic: true }, select: publicCertificateSelect }, batches: { select: { id: true, expiryDate: true, status: true, certificates: { where: { isPublic: true }, select: publicCertificateSelect } } } } } } })
  if (!identity || identity.product.domain !== 'PHARMACEUTICAL') return response.status(404).json({ message: 'Verification requires review' })

  const [allEvents, productEvents] = await Promise.all([
    prisma.supplyChainEvent.findMany({ orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }),
    prisma.supplyChainEvent.findMany({ where: { productId: identity.productId }, orderBy: { createdAt: 'asc' }, select: { id: true, currentHash: true, blockchainStatus: true, blockchainTransactionHash: true, anchor: { select: { status: true, transactionHash: true } } } }),
  ])
  const chainVerified = verifyHashChain(allEvents.map((event) => ({ currentHash: event.currentHash, previousHash: event.previousHash, eventData: eventDataFromRecord(event) })))
  const publicCertificates = [...identity.product.certificates, ...identity.product.batches.flatMap((batch) => batch.certificates)]
  const uniquePublicCertificates = [...new Map(publicCertificates.map((certificate) => [certificate.id, certificate])).values()]
  const certificateVerified = uniquePublicCertificates.length > 0 && uniquePublicCertificates.every((certificate) => certificate.verifiedAt !== null)
  const recallItems = identity.product.batches.length
    ? await prisma.recallItem.findMany({ where: { batchId: { in: identity.product.batches.map((batch) => batch.id) } }, include: { recall: { select: { status: true } } } })
    : []
  const recalled = recallItems.some((item) => item.recall.status === 'ACTIVE')
  const expired = identity.product.batches.some((batch) => batch.status === 'EXPIRED' || batch.expiryDate <= new Date())
  const blockchainConfiguration = await blockchain.getStatus()
  const blockchainProofs = await Promise.all(productEvents.map(async (event) => {
    const anchorStatus = event.anchor?.status ?? event.blockchainStatus
    if (anchorStatus === 'ANCHOR_FAILED') return { eventId: event.id, eventHash: event.currentHash, status: 'ANCHOR_FAILED' as const, transactionHash: event.anchor?.transactionHash ?? event.blockchainTransactionHash, blockNumber: null, timestamp: null, contractAddress: null, chainId: null, networkName: null }
    if (anchorStatus !== 'ANCHORED') return { eventId: event.id, eventHash: event.currentHash, status: 'PENDING' as const, transactionHash: null, blockNumber: null, timestamp: null, contractAddress: null, chainId: null, networkName: null }
    const verification = await blockchain.verify(event.currentHash)
    if (verification.status === 'ANCHORED' && verification.proof) {
      return {
        eventId: event.id, eventHash: event.currentHash, status: 'ANCHORED' as const,
        transactionHash: verification.proof.transactionHash, blockNumber: verification.proof.blockNumber?.toString() ?? null,
        timestamp: verification.proof.timestamp?.toString() ?? null, contractAddress: blockchainConfiguration.contractAddress,
        chainId: blockchainConfiguration.chainId, networkName: blockchainConfiguration.networkName,
      }
    }
    if (verification.status === 'NOT_ANCHORED') return { eventId: event.id, eventHash: event.currentHash, status: 'ANCHOR_FAILED' as const, transactionHash: null, blockNumber: null, timestamp: null, contractAddress: blockchainConfiguration.contractAddress, chainId: blockchainConfiguration.chainId, networkName: blockchainConfiguration.networkName }
    return { eventId: event.id, eventHash: event.currentHash, status: 'UNAVAILABLE' as const, transactionHash: null, blockNumber: null, timestamp: null, contractAddress: blockchainConfiguration.contractAddress, chainId: blockchainConfiguration.chainId, networkName: blockchainConfiguration.networkName }
  }))
  const blockchainAnchorVerified = blockchainProofs.length > 0 && blockchainProofs.every((proof) => proof.status === 'ANCHORED')
  const blockchainStatus = blockchainProofs.some((proof) => proof.status === 'ANCHOR_FAILED')
    ? 'ANCHOR_FAILED'
    : blockchainProofs.some((proof) => proof.status === 'UNAVAILABLE')
      ? 'UNAVAILABLE'
      : blockchainProofs.some((proof) => proof.status === 'PENDING')
        ? blockchainConfiguration.configured ? 'PENDING' : 'NOT_CONFIGURED'
        : blockchainAnchorVerified ? 'ANCHORED' : 'NOT_CONFIGURED'

  return response.json({
    verified: chainVerified && !recalled && !expired,
    status: recalled ? 'RECALLED' : expired ? 'REVIEW' : chainVerified ? 'VERIFIED' : 'REVIEW',
    databaseChainVerified: chainVerified,
    blockchainAnchorVerified,
    blockchainVerification: { status: blockchainStatus, anchorCount: blockchainProofs.filter((proof) => proof.status === 'ANCHORED').length, totalEventCount: productEvents.length, proofs: blockchainProofs },
    certificateVerified,
    expired,
    product: {
      brandName: identity.product.brandName,
      genericName: identity.product.genericName,
      dosageForm: identity.product.attributes && typeof identity.product.attributes === 'object' ? (identity.product.attributes as Record<string, unknown>).dosageForm : null,
      strength: identity.product.attributes && typeof identity.product.attributes === 'object' ? (identity.product.attributes as Record<string, unknown>).strength : null,
    },
    certificates: uniquePublicCertificates.map(({ certificateNumber, type, issuer, issuedAt, expiresAt, verifiedAt, status }) => ({ certificateNumber, type, issuer, issuedAt, expiresAt, verifiedAt, status })),
    eventCount: productEvents.length,
    certificateCount: uniquePublicCertificates.length,
    recalled,
  })
})
