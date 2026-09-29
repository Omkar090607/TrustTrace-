import { Router } from 'express'
import { BatchStatus, Prisma } from '@prisma/client'
import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { authenticate, requireOrganization, requireOrganizationPermission } from '../middleware/auth.js'
import { createBatchSchema, updateBatchSchema } from '../domain/batch.js'
import { appendSupplyChainEvent } from '../services/append-event.js'
import { notifyOrganizationMembers } from '../services/operational-records.js'

export const batchesRouter = Router()
batchesRouter.use(authenticate, requireOrganization)

const batchIdSchema = z.string().uuid()

type BatchRecord = Prisma.BatchGetPayload<{
  include: {
    product: { include: { identity: true } }
    storageLocation: true
    qualityChecks: { orderBy: { createdAt: 'desc' } }
  }
}>

function batchResponse(batch: BatchRecord) {
  const attributes = batch.product.attributes && typeof batch.product.attributes === 'object'
    ? batch.product.attributes as Record<string, unknown>
    : {}
  return {
    ...batch,
    product: {
      id: batch.product.id,
      name: batch.product.name,
      genericName: batch.product.genericName,
      brandName: batch.product.brandName,
      traceId: batch.product.identity?.traceId ?? null,
    },
    manufacturer: batch.manufacturer || String(attributes.manufacturer ?? ''),
    storageLocation: batch.storageLocation?.name ?? null,
  }
}

async function resolveStorageLocation(
  transaction: Prisma.TransactionClient,
  organizationId: string,
  locationName: string | null | undefined,
) {
  if (!locationName) return null
  const existing = await transaction.inventoryLocation.findFirst({ where: { organizationId, name: locationName } })
  if (existing) return existing
  return transaction.inventoryLocation.create({ data: { organizationId, name: locationName } })
}

batchesRouter.get('/', requireOrganizationPermission('batch:read'), async (request, response) => {
  const search = typeof request.query.search === 'string' ? request.query.search.trim() : ''
  const status = typeof request.query.status === 'string' && Object.values(BatchStatus).includes(request.query.status as BatchStatus)
    ? request.query.status as BatchStatus
    : undefined
  const pageValue = Number(request.query.page ?? 1)
  const page = Number.isInteger(pageValue) && pageValue > 0 ? pageValue : 1
  const where: Prisma.BatchWhereInput = {
    product: { organizationId: request.auth!.organizationId, domain: 'PHARMACEUTICAL' },
    ...(status ? { status } : {}),
    ...(search ? { OR: [
      { batchNumber: { contains: search, mode: 'insensitive' } },
      { product: { name: { contains: search, mode: 'insensitive' } } },
      { product: { genericName: { contains: search, mode: 'insensitive' } } },
    ] } : {}),
  }
  const [items, total] = await prisma.$transaction([
    prisma.batch.findMany({ where, orderBy: { createdAt: 'desc' }, take: 50, skip: (page - 1) * 50, include: { product: { include: { identity: true } }, storageLocation: true, qualityChecks: { orderBy: { createdAt: 'desc' } } } }),
    prisma.batch.count({ where }),
  ])
  return response.json({ items: items.map(batchResponse), total, page, pageSize: 50 })
})

batchesRouter.post('/', requireOrganizationPermission('batch:create'), async (request, response) => {
  const parsed = createBatchSchema.safeParse(request.body)
  if (!parsed.success) return response.status(400).json({ message: 'Invalid batch details', issues: parsed.error.issues.map((issue) => ({ field: issue.path.join('.'), message: issue.message })) })
  const input = parsed.data
  const product = await prisma.product.findFirst({
    where: { id: input.productId, organizationId: request.auth!.organizationId, domain: 'PHARMACEUTICAL' },
    select: { id: true, name: true, attributes: true },
  })
  if (!product) return response.status(404).json({ message: 'Pharmaceutical product not found in this organization' })
  const productAttributes = product.attributes && typeof product.attributes === 'object' ? product.attributes as Record<string, unknown> : {}
  const manufacturer = typeof productAttributes.manufacturer === 'string' ? productAttributes.manufacturer : ''
  if (!manufacturer) return response.status(409).json({ message: 'Product manufacturer details are required before a batch can be created' })

  try {
    const batch = await prisma.$transaction(async (transaction) => {
      const location = await resolveStorageLocation(transaction, request.auth!.organizationId, input.storageLocation)
      const created = await transaction.batch.create({
        data: {
          batchNumber: input.batchNumber,
          productId: product.id,
          manufacturingDate: input.manufacturingDate,
          expiryDate: input.expiryDate,
          quantityManufactured: input.quantityManufactured,
          available: 0,
          manufacturer,
          manufacturingLocation: input.manufacturingLocation,
          storageLocationId: location?.id,
          unitCost: input.unitCost,
          sellingPrice: input.sellingPrice,
          currency: input.currency,
          status: 'MANUFACTURED',
          qualityStatus: 'PENDING',
        },
      })
      await appendSupplyChainEvent(transaction, {
        productId: product.id,
        batchId: created.id,
        actorId: request.auth!.userId,
        organizationId: request.auth!.organizationId,
        eventType: 'BATCH_CREATED',
        quantity: input.quantityManufactured,
        metadata: { batchNumber: created.batchNumber, expiryDate: created.expiryDate.toISOString() },
      })
      await transaction.auditLog.create({
        data: { actorId: request.auth!.userId, organizationId: request.auth!.organizationId, action: 'BATCH_CREATED', resourceType: 'Batch', resourceId: created.id, metadata: { batchNumber: created.batchNumber } },
      })
      return transaction.batch.findUniqueOrThrow({
        where: { id: created.id },
        include: { product: { include: { identity: true } }, storageLocation: true, qualityChecks: { orderBy: { createdAt: 'desc' } } },
      })
    })
    return response.status(201).json(batchResponse(batch))
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return response.status(409).json({ message: 'A batch with this number already exists' })
    throw error
  }
})

batchesRouter.get('/:id', requireOrganizationPermission('batch:read'), async (request, response) => {
  const id = batchIdSchema.safeParse(request.params.id)
  if (!id.success) return response.status(400).json({ message: 'A valid batch ID is required' })
  const batch = await prisma.batch.findFirst({
    where: { id: id.data, product: { organizationId: request.auth!.organizationId, domain: 'PHARMACEUTICAL' } },
    include: { product: { include: { identity: true } }, storageLocation: true, qualityChecks: { orderBy: { createdAt: 'desc' } } },
  })
  if (!batch) return response.status(404).json({ message: 'Batch not found' })
  return response.json(batchResponse(batch))
})

batchesRouter.patch('/:id', requireOrganizationPermission('batch:update'), async (request, response) => {
  const id = batchIdSchema.safeParse(request.params.id)
  const parsed = updateBatchSchema.safeParse(request.body)
  if (!id.success) return response.status(400).json({ message: 'A valid batch ID is required' })
  if (!parsed.success) return response.status(400).json({ message: 'Invalid permitted batch fields', issues: parsed.error.issues.map((issue) => ({ field: issue.path.join('.'), message: issue.message })) })
  const input = parsed.data
  const updated = await prisma.$transaction(async (transaction) => {
    const existing = await transaction.batch.findFirst({
      where: { id: id.data, product: { organizationId: request.auth!.organizationId, domain: 'PHARMACEUTICAL' } },
    })
    if (!existing) return null
    const location = input.storageLocation === undefined
      ? undefined
      : await resolveStorageLocation(transaction, request.auth!.organizationId, input.storageLocation)
    const batch = await transaction.batch.update({
      where: { id: existing.id },
      data: {
        manufacturingLocation: input.manufacturingLocation,
        storageLocationId: location === undefined ? undefined : location?.id ?? null,
        unitCost: input.unitCost,
        sellingPrice: input.sellingPrice,
        currency: input.currency,
      },
      include: { product: { include: { identity: true } }, storageLocation: true, qualityChecks: { orderBy: { createdAt: 'desc' } } },
    })
    await appendSupplyChainEvent(transaction, {
      productId: batch.productId,
      batchId: batch.id,
      actorId: request.auth!.userId,
      organizationId: request.auth!.organizationId,
      eventType: 'BATCH_UPDATED',
      metadata: { changedFields: Object.keys(input) },
    })
    await transaction.auditLog.create({
      data: { actorId: request.auth!.userId, organizationId: request.auth!.organizationId, action: 'BATCH_UPDATED', resourceType: 'Batch', resourceId: batch.id, metadata: { changedFields: Object.keys(input) } },
    })
    return batch
  })
  if (!updated) return response.status(404).json({ message: 'Batch not found' })
  return response.json(batchResponse(updated))
})

batchesRouter.post('/:id/quality-checks', requireOrganizationPermission('quality:manage'), async (request, response) => {
  const id = batchIdSchema.safeParse(request.params.id)
  const parsed = z.object({ result: z.enum(['PASS', 'FAIL']), notes: z.string().trim().max(2000).optional() }).strict().safeParse(request.body)
  if (!id.success) return response.status(400).json({ message: 'A valid batch ID is required' })
  if (!parsed.success) return response.status(400).json({ message: 'Quality result must be PASS or FAIL', issues: parsed.error.issues.map((issue) => ({ field: issue.path.join('.'), message: issue.message })) })

  const result = await prisma.$transaction(async (transaction) => {
    const batch = await transaction.batch.findFirst({ where: { id: id.data, product: { organizationId: request.auth!.organizationId, domain: 'PHARMACEUTICAL' } } })
    if (!batch) return null
    if (batch.status === 'DISPATCHED' || batch.status === 'IN_TRANSIT' || batch.status === 'OUT_FOR_DELIVERY' || batch.status === 'DELIVERED') {
      return { conflict: true as const }
    }
    const passed = parsed.data.result === 'PASS'
    const qualityStatus = passed ? 'PASSED' : 'FAILED'
    const status = passed ? 'APPROVED' : 'QUARANTINED'
    const checkedAt = new Date()
    const check = await transaction.qualityCheck.create({
      data: { batchId: batch.id, performedBy: request.auth!.userId, result: qualityStatus, details: { notes: parsed.data.notes ?? '' }, checkedAt },
    })
    const updated = await transaction.batch.update({ where: { id: batch.id }, data: { qualityStatus, status } })
    const baseEvent = {
      productId: batch.productId,
      batchId: batch.id,
      actorId: request.auth!.userId,
      organizationId: request.auth!.organizationId,
      metadata: { result: parsed.data.result, notes: parsed.data.notes ?? '' },
    }
    await appendSupplyChainEvent(transaction, { ...baseEvent, eventType: 'QUALITY_CHECK' })
    await appendSupplyChainEvent(transaction, { ...baseEvent, eventType: passed ? 'APPROVED' : 'FAILED' })
    await transaction.auditLog.create({
      data: { actorId: request.auth!.userId, organizationId: request.auth!.organizationId, action: 'QUALITY_CHECKED', resourceType: 'Batch', resourceId: batch.id, metadata: { result: parsed.data.result } },
    })
    await notifyOrganizationMembers(transaction, request.auth!.organizationId, passed ? 'Batch approved' : 'Batch quarantined', `${batch.batchNumber} quality inspection ${passed ? 'passed' : 'failed'}.`)
    return { check, batch: updated }
  })
  if (!result) return response.status(404).json({ message: 'Batch not found' })
  if ('conflict' in result) return response.status(409).json({ message: 'Quality status cannot change after dispatch' })
  return response.status(201).json({ id: result.check.id, result: result.check.result, checkedAt: result.check.checkedAt, status: result.batch.status })
})

