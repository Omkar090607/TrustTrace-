import { randomUUID } from 'node:crypto'
import { PaymentStatus, Prisma, ReturnStatus } from '@prisma/client'
import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { authenticate, requireOrganization, requireOrganizationPermission } from '../middleware/auth.js'
import { appendSupplyChainEvent } from '../services/append-event.js'
import { notifyOrganizationMembers } from '../services/operational-records.js'

export const phase4Router = Router()
phase4Router.use(authenticate, requireOrganization)

const uuidSchema = z.string().uuid()
const moneySchema = z.string().regex(/^(0|[1-9]\d{0,9})(\.\d{1,4})?$/)
const currencySchema = z.string().regex(/^[A-Z]{3}$/)
const returnInclude = {
  shipment: { select: { id: true, trackingNumber: true, status: true } },
  requestedBy: { select: { id: true, fullName: true } },
  items: {
    include: {
      batch: { select: { id: true, batchNumber: true, product: { select: { id: true, name: true } } } },
      inspections: { orderBy: { inspectedAt: 'desc' as const } },
    },
  },
}

async function audit(client: Prisma.TransactionClient, input: {
  organizationId: string
  actorId: string
  action: string
  resourceType: string
  resourceId: string
  metadata?: Prisma.InputJsonValue
}) {
  await client.auditLog.create({
    data: {
      organizationId: input.organizationId,
      actorId: input.actorId,
      action: input.action,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      metadata: input.metadata ?? {},
    },
  })
}

async function notifyOrganization(client: Prisma.TransactionClient, organizationId: string, title: string, body: string) {
  await notifyOrganizationMembers(client, organizationId, title, body)
}

const createReturnSchema = z.object({
  shipmentId: uuidSchema,
  reason: z.string().trim().min(2).max(1000),
  items: z.array(z.object({ batchId: uuidSchema, quantity: z.number().int().positive().max(1000000000) }).strict()).min(1).max(50),
}).strict().refine((value) => new Set(value.items.map(({ batchId }) => batchId)).size === value.items.length, {
  path: ['items'], message: 'Each batch may only appear once in a return',
})

phase4Router.get('/returns', requireOrganizationPermission('return:read'), async (request, response) => {
  const status = request.query.status ? z.nativeEnum(ReturnStatus).safeParse(request.query.status) : null
  if (status && !status.success) return response.status(400).json({ message: 'Invalid return status' })
  const items = await prisma.return.findMany({
    where: { organizationId: request.auth!.organizationId, ...(status?.success ? { status: status.data } : {}) },
    orderBy: { createdAt: 'desc' }, take: 100, include: returnInclude,
  })
  return response.json({ items, total: items.length })
})

phase4Router.post('/returns', requireOrganizationPermission('return:create'), async (request, response) => {
  const parsed = createReturnSchema.safeParse(request.body)
  if (!parsed.success) return response.status(400).json({ message: 'Invalid return details', issues: parsed.error.issues })
  const input = parsed.data
  const batchIds = input.items.map(({ batchId }) => batchId).sort()
  const result = await prisma.$transaction(async (tx) => {
    for (const batchId of batchIds) await tx.$queryRaw`SELECT "id" FROM "Batch" WHERE "id" = ${batchId}::uuid FOR UPDATE`
    const shipment = await tx.shipment.findFirst({
      where: { id: input.shipmentId, organizationId: request.auth!.organizationId, status: 'DELIVERED' },
      include: { items: { include: { batch: { include: { product: true } } } } },
    })
    if (!shipment) return { kind: 'shipment-not-found' as const }
    const priorReturns = await tx.return.findMany({
      where: { organizationId: request.auth!.organizationId, shipmentId: shipment.id, status: { not: 'REJECTED' } },
      include: { items: { select: { batchId: true, quantity: true } } },
    })
    const usedByBatch = new Map<string, number>()
    for (const prior of priorReturns) for (const item of prior.items) usedByBatch.set(item.batchId, (usedByBatch.get(item.batchId) ?? 0) + item.quantity)
    const shipmentItems = new Map(shipment.items.map((item) => [item.batchId, item]))
    for (const inputItem of input.items) {
      const shipped = shipmentItems.get(inputItem.batchId)
      if (!shipped || shipped.batch.product.organizationId !== request.auth!.organizationId) return { kind: 'batch-not-in-shipment' as const }
      const batch = await tx.batch.findUnique({ where: { id: inputItem.batchId }, select: { delivered: true, returned: true } })
      const shipmentRemaining = shipped.quantity - (usedByBatch.get(inputItem.batchId) ?? 0)
      const batchRemaining = (batch?.delivered ?? 0) - (batch?.returned ?? 0)
      if (inputItem.quantity > Math.min(shipmentRemaining, batchRemaining)) return { kind: 'quantity-exceeded' as const }
    }
    const returnRecord = await tx.return.create({
      data: {
        returnNumber: `TT-RET-${randomUUID().toUpperCase()}`,
        organizationId: request.auth!.organizationId,
        shipmentId: shipment.id,
        requestedById: request.auth!.userId,
        reason: input.reason,
        status: 'REQUESTED',
        items: { create: input.items.map((item) => ({ ...item, deliveredQuantity: shipmentItems.get(item.batchId)!.quantity })) },
      },
      include: returnInclude,
    })
    for (const item of input.items) {
      const batch = shipmentItems.get(item.batchId)!.batch
      await appendSupplyChainEvent(tx, {
        productId: batch.productId, batchId: batch.id, organizationId: request.auth!.organizationId,
        actorId: request.auth!.userId, quantity: item.quantity, eventType: 'RETURN_REQUESTED',
        metadata: { returnNumber: returnRecord.returnNumber, shipment: shipment.trackingNumber },
      })
    }
    await audit(tx, { organizationId: request.auth!.organizationId, actorId: request.auth!.userId, action: 'RETURN_REQUESTED', resourceType: 'Return', resourceId: returnRecord.id, metadata: { returnNumber: returnRecord.returnNumber, itemCount: input.items.length } })
    return { kind: 'ok' as const, returnRecord }
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
  if (result.kind === 'shipment-not-found') return response.status(404).json({ message: 'Delivered shipment not found in this organization' })
  if (result.kind === 'batch-not-in-shipment') return response.status(400).json({ message: 'Each returned batch must be part of the delivered shipment' })
  if (result.kind === 'quantity-exceeded') return response.status(409).json({ message: 'Return quantity exceeds the eligible delivered quantity' })
  return response.status(201).json(result.returnRecord)
})

phase4Router.get('/returns/:id', requireOrganizationPermission('return:read'), async (request, response) => {
  const id = uuidSchema.safeParse(request.params.id)
  if (!id.success) return response.status(400).json({ message: 'A valid return ID is required' })
  const item = await prisma.return.findFirst({ where: { id: id.data, organizationId: request.auth!.organizationId }, include: returnInclude })
  if (!item) return response.status(404).json({ message: 'Return not found' })
  return response.json(item)
})

phase4Router.post('/returns/:id/receive', requireOrganizationPermission('return:update'), async (request, response) => {
  const id = uuidSchema.safeParse(request.params.id)
  if (!id.success) return response.status(400).json({ message: 'A valid return ID is required' })
  const result = await prisma.$transaction(async (tx) => {
    const current = await tx.return.findFirst({ where: { id: id.data, organizationId: request.auth!.organizationId }, include: { items: { include: { batch: true } } } })
    if (!current) return { kind: 'not-found' as const }
    if (current.status !== 'REQUESTED') return { kind: 'invalid-state' as const }
    const updated = await tx.return.update({ where: { id: current.id }, data: { status: 'RECEIVED' }, include: returnInclude })
    for (const item of current.items) await appendSupplyChainEvent(tx, {
      productId: item.batch.productId, batchId: item.batchId, organizationId: request.auth!.organizationId,
      actorId: request.auth!.userId, quantity: item.quantity, eventType: 'RETURN_RECEIVED', metadata: { returnNumber: current.returnNumber },
    })
    await audit(tx, { organizationId: request.auth!.organizationId, actorId: request.auth!.userId, action: 'RETURN_RECEIVED', resourceType: 'Return', resourceId: current.id })
    await notifyOrganization(tx, request.auth!.organizationId, 'Return received', `${current.returnNumber} has been received for inspection.`)
    return { kind: 'ok' as const, item: updated }
  })
  if (result.kind === 'not-found') return response.status(404).json({ message: 'Return not found' })
  if (result.kind === 'invalid-state') return response.status(409).json({ message: 'Only requested returns can be received' })
  return response.json(result.item)
})

const inspectReturnSchema = z.object({
  inspections: z.array(z.object({ returnItemId: uuidSchema, outcome: z.enum(['PASS', 'DAMAGED', 'REJECTED', 'RECALLED']), notes: z.string().trim().max(1000).optional() }).strict()).min(1).max(50),
}).strict()

phase4Router.post('/returns/:id/inspect', requireOrganizationPermission('return:update'), async (request, response) => {
  const id = uuidSchema.safeParse(request.params.id)
  const parsed = inspectReturnSchema.safeParse(request.body)
  if (!id.success) return response.status(400).json({ message: 'A valid return ID is required' })
  if (!parsed.success) return response.status(400).json({ message: 'Invalid inspection details', issues: parsed.error.issues })
  const result = await prisma.$transaction(async (tx) => {
    const current = await tx.return.findFirst({ where: { id: id.data, organizationId: request.auth!.organizationId }, include: { items: { include: { batch: true } } } })
    if (!current) return { kind: 'not-found' as const }
    if (current.status !== 'RECEIVED') return { kind: 'invalid-state' as const }
    if (new Set(parsed.data.inspections.map((entry) => entry.returnItemId)).size !== current.items.length || current.items.some((item) => !parsed.data.inspections.some((entry) => entry.returnItemId === item.id))) return { kind: 'incomplete' as const }
    for (const entry of parsed.data.inspections) {
      if (!current.items.some((item) => item.id === entry.returnItemId)) return { kind: 'incomplete' as const }
      await tx.returnInspection.create({ data: { returnItemId: entry.returnItemId, outcome: entry.outcome, notes: entry.notes, inspectedBy: request.auth!.userId } })
    }
    const rejected = parsed.data.inspections.some((entry) => entry.outcome !== 'PASS')
    const updated = await tx.return.update({ where: { id: current.id }, data: { status: rejected ? 'REJECTED' : 'INSPECTING' }, include: returnInclude })
    for (const item of current.items) await appendSupplyChainEvent(tx, {
      productId: item.batch.productId, batchId: item.batchId, organizationId: request.auth!.organizationId,
      actorId: request.auth!.userId, quantity: item.quantity, eventType: rejected ? 'RETURN_REJECTED' : 'RETURN_INSPECTED',
      metadata: { returnNumber: current.returnNumber },
    })
    await audit(tx, { organizationId: request.auth!.organizationId, actorId: request.auth!.userId, action: rejected ? 'RETURN_REJECTED' : 'RETURN_INSPECTED', resourceType: 'Return', resourceId: current.id, metadata: { inspectedItems: current.items.length } })
    return { kind: 'ok' as const, item: updated }
  })
  if (result.kind === 'not-found') return response.status(404).json({ message: 'Return not found' })
  if (result.kind === 'invalid-state') return response.status(409).json({ message: 'Only received returns can be inspected' })
  if (result.kind === 'incomplete') return response.status(400).json({ message: 'Every return item must be inspected exactly once' })
  return response.json(result.item)
})

phase4Router.post('/returns/:id/restock', requireOrganizationPermission('return:update'), async (request, response) => {
  const id = uuidSchema.safeParse(request.params.id)
  const parsed = z.object({ locationId: uuidSchema.optional() }).strict().safeParse(request.body)
  if (!id.success || !parsed.success) return response.status(400).json({ message: 'Invalid restock details' })
  const result = await prisma.$transaction(async (tx) => {
    const current = await tx.return.findFirst({ where: { id: id.data, organizationId: request.auth!.organizationId }, include: { items: { include: { batch: true, inspections: { orderBy: { inspectedAt: 'desc' } } } } } })
    if (!current) return { kind: 'not-found' as const }
    if (current.status !== 'INSPECTING' || current.items.some((item) => item.inspections[0]?.outcome !== 'PASS')) return { kind: 'not-inspected' as const }
    const prepared = []
    for (const item of current.items) {
      const locationId = parsed.data.locationId ?? item.batch.storageLocationId
      if (!locationId) return { kind: 'location-required' as const }
      const location = await tx.inventoryLocation.findFirst({ where: { id: locationId, organizationId: request.auth!.organizationId } })
      if (!location) return { kind: 'location-not-found' as const }
      if (item.batch.expiryDate <= new Date() || item.batch.qualityStatus !== 'PASSED' || item.batch.recalled > 0 || ['RECALLED', 'DISPOSED', 'EXPIRED'].includes(item.batch.status)) return { kind: 'batch-blocked' as const }
      prepared.push({ item, location })
    }
    for (const { item, location } of prepared) {
      await tx.inventory.upsert({
        where: { batchId_locationId: { batchId: item.batchId, locationId: location.id } },
        create: { batchId: item.batchId, locationId: location.id, onHand: item.quantity, reserved: 0 },
        update: { onHand: { increment: item.quantity } },
      })
      await tx.inventoryMovement.create({ data: { batchId: item.batchId, locationId: location.id, quantity: item.quantity, reason: `RETURN_RESTOCKED:${current.returnNumber}`, actorId: request.auth!.userId } })
      await tx.batch.update({ where: { id: item.batchId }, data: { available: { increment: item.quantity }, returned: { increment: item.quantity }, status: 'IN_WAREHOUSE', storageLocationId: location.id } })
      await appendSupplyChainEvent(tx, {
        productId: item.batch.productId, batchId: item.batchId, organizationId: request.auth!.organizationId,
        actorId: request.auth!.userId, locationId: location.id, quantity: item.quantity, eventType: 'RETURN_RESTOCKED',
        metadata: { returnNumber: current.returnNumber },
      })
    }
    const updated = await tx.return.update({ where: { id: current.id }, data: { status: 'RESTOCKED' }, include: returnInclude })
    await audit(tx, { organizationId: request.auth!.organizationId, actorId: request.auth!.userId, action: 'RETURN_RESTOCKED', resourceType: 'Return', resourceId: current.id, metadata: { itemCount: current.items.length } })
    return { kind: 'ok' as const, item: updated }
  })
  if (result.kind === 'not-found') return response.status(404).json({ message: 'Return not found' })
  if (result.kind === 'not-inspected') return response.status(409).json({ message: 'Every item must pass inspection before restocking' })
  if (result.kind === 'location-required') return response.status(409).json({ message: 'Choose an organization inventory location before restocking' })
  if (result.kind === 'location-not-found') return response.status(404).json({ message: 'Inventory location not found in this organization' })
  if (result.kind === 'batch-blocked') return response.status(409).json({ message: 'Expired, recalled, or unapproved batches cannot be restocked' })
  return response.json(result.item)
})

const certificateSchema = z.object({
  certificateNumber: z.string().trim().min(2).max(120),
  type: z.string().trim().min(2).max(80),
  issuer: z.string().trim().min(2).max(180),
  issuedAt: z.string().datetime().optional(),
  expiresAt: z.string().datetime().optional(),
  isPublic: z.boolean().default(false),
}).strict()
const createDocumentSchema = z.object({
  name: z.string().trim().min(2).max(180),
  contentType: z.string().trim().min(3).max(120),
  sizeBytes: z.number().int().positive().max(100000000),
  checksum: z.string().regex(/^[a-f0-9]{64}$/i),
  productId: uuidSchema.optional(), batchId: uuidSchema.optional(), shipmentId: uuidSchema.optional(), returnId: uuidSchema.optional(),
  certificate: certificateSchema.optional(),
}).strict().refine((value) => Boolean(value.productId || value.batchId || value.shipmentId || value.returnId) || !value.certificate, {
  message: 'A certificate must be associated with a product or batch',
})

phase4Router.get('/documents', requireOrganizationPermission('document:read'), async (request, response) => {
  const productId = request.query.productId ? uuidSchema.safeParse(request.query.productId) : null
  const batchId = request.query.batchId ? uuidSchema.safeParse(request.query.batchId) : null
  if (productId && !productId.success || batchId && !batchId.success) return response.status(400).json({ message: 'Invalid document filter' })
  const [items, certificates] = await Promise.all([prisma.document.findMany({
    where: { organizationId: request.auth!.organizationId, ...(productId?.success ? { productId: productId.data } : {}), ...(batchId?.success ? { batchId: batchId.data } : {}) },
    orderBy: { uploadedAt: 'desc' }, take: 100,
    include: { product: { select: { id: true, name: true } }, batch: { select: { id: true, batchNumber: true } }, shipment: { select: { id: true, trackingNumber: true } }, returnRecord: { select: { id: true, returnNumber: true } } },
  }), prisma.certificate.findMany({
    where: {
      OR: [{ product: { organizationId: request.auth!.organizationId } }, { batch: { product: { organizationId: request.auth!.organizationId } } }],
      ...(productId?.success ? { productId: productId.data } : {}), ...(batchId?.success ? { batchId: batchId.data } : {}),
    },
    orderBy: { createdAt: 'desc' }, take: 100,
    include: { product: { select: { id: true, name: true } }, batch: { select: { id: true, batchNumber: true } } },
  })])
  return response.json({
    items: items.map(({ storageKey: _storageKey, ...item }) => ({ ...item, downloadAvailable: false })),
    certificates: certificates.map(({ id, certificateNumber, type, issuer, issuedAt, expiresAt, verifiedAt, status, isPublic, product, batch }) => ({ id, certificateNumber, type, issuer, issuedAt, expiresAt, verifiedAt, status, isPublic, product, batch })),
    total: items.length + certificates.length,
  })
})

phase4Router.post('/documents', requireOrganizationPermission('document:create'), async (request, response) => {
  const parsed = createDocumentSchema.safeParse(request.body)
  if (!parsed.success) return response.status(400).json({ message: 'Invalid document metadata', issues: parsed.error.issues })
  const input = parsed.data
  const organizationId = request.auth!.organizationId
  const result = await prisma.$transaction(async (tx) => {
    let productId = input.productId
    let batch
    if (input.batchId) {
      batch = await tx.batch.findFirst({ where: { id: input.batchId, product: { organizationId } }, select: { id: true, productId: true } })
      if (!batch) return { kind: 'resource-not-found' as const }
      if (productId && productId !== batch.productId) return { kind: 'association-mismatch' as const }
      productId = batch.productId
    }
    if (productId && !await tx.product.findFirst({ where: { id: productId, organizationId }, select: { id: true } })) return { kind: 'resource-not-found' as const }
    if (input.shipmentId && !await tx.shipment.findFirst({ where: { id: input.shipmentId, organizationId }, select: { id: true } })) return { kind: 'resource-not-found' as const }
    if (input.returnId && !await tx.return.findFirst({ where: { id: input.returnId, organizationId }, select: { id: true } })) return { kind: 'resource-not-found' as const }
    if (input.certificate && !productId) return { kind: 'certificate-product-required' as const }
    const document = await tx.document.create({
      data: {
        name: input.name, contentType: input.contentType, sizeBytes: input.sizeBytes, checksum: input.checksum,
        storageKey: `metadata-only:${randomUUID()}`, organizationId, uploadedById: request.auth!.userId,
        productId, batchId: input.batchId, shipmentId: input.shipmentId, returnId: input.returnId,
      },
    })
    const eventBatch = input.batchId ? await tx.batch.findUnique({ where: { id: input.batchId }, select: { id: true, productId: true } }) : null
    if (input.certificate) {
      const certificate = await tx.certificate.create({
        data: {
          certificateNumber: input.certificate.certificateNumber, type: input.certificate.type, issuer: input.certificate.issuer,
          issuedAt: input.certificate.issuedAt ? new Date(input.certificate.issuedAt) : null,
          expiresAt: input.certificate.expiresAt ? new Date(input.certificate.expiresAt) : null,
          isPublic: input.certificate.isPublic, productId, batchId: input.batchId, documentId: document.id,
        },
      })
      await appendSupplyChainEvent(tx, {
        productId: productId!, batchId: eventBatch?.id, organizationId, actorId: request.auth!.userId,
        eventType: 'CERTIFICATE_REGISTERED', metadata: { certificateNumber: certificate.certificateNumber, type: certificate.type },
      })
    } else if (productId) {
      await appendSupplyChainEvent(tx, {
        productId, batchId: eventBatch?.id, organizationId, actorId: request.auth!.userId,
        eventType: 'DOCUMENT_REGISTERED', metadata: { documentName: input.name, contentType: input.contentType, checksum: input.checksum },
      })
    }
    await audit(tx, { organizationId, actorId: request.auth!.userId, action: input.certificate ? 'CERTIFICATE_REGISTERED' : 'DOCUMENT_REGISTERED', resourceType: input.certificate ? 'Certificate' : 'Document', resourceId: document.id, metadata: { name: input.name, contentType: input.contentType, sizeBytes: input.sizeBytes, isPublic: input.certificate?.isPublic ?? false } })
    return { kind: 'ok' as const, document }
  })
  if (result.kind === 'resource-not-found') return response.status(404).json({ message: 'Associated resource not found in this organization' })
  if (result.kind === 'association-mismatch') return response.status(400).json({ message: 'Batch does not belong to the selected product' })
  if (result.kind === 'certificate-product-required') return response.status(400).json({ message: 'Certificates must be associated with a product or batch' })
  return response.status(201).json({ id: result.document.id, name: result.document.name, contentType: result.document.contentType, sizeBytes: result.document.sizeBytes, checksum: result.document.checksum, uploadedAt: result.document.uploadedAt, downloadAvailable: false })
})

phase4Router.get('/documents/:id', requireOrganizationPermission('document:read'), async (request, response) => {
  const id = uuidSchema.safeParse(request.params.id)
  if (!id.success) return response.status(400).json({ message: 'A valid document ID is required' })
  const document = await prisma.document.findFirst({ where: { id: id.data, organizationId: request.auth!.organizationId }, select: { id: true, name: true, contentType: true, sizeBytes: true, checksum: true, uploadedAt: true, productId: true, batchId: true, shipmentId: true, returnId: true } })
  if (!document) return response.status(404).json({ message: 'Document not found' })
  return response.json({ ...document, downloadAvailable: false })
})

const invoiceInclude = { items: true, payments: { include: { refunds: true, recordedBy: { select: { id: true, fullName: true } } } }, createdBy: { select: { id: true, fullName: true } } }
const createInvoiceSchema = z.object({
  currency: currencySchema.default('USD'),
  items: z.array(z.object({ description: z.string().trim().min(2).max(300), quantity: z.number().int().positive().max(1000000), unitPrice: moneySchema }).strict()).min(1).max(100),
}).strict()

phase4Router.get('/invoices', requireOrganizationPermission('invoice:read'), async (request, response) => {
  const items = await prisma.invoice.findMany({ where: { organizationId: request.auth!.organizationId }, orderBy: { createdAt: 'desc' }, take: 100, include: { _count: { select: { items: true, payments: true } } } })
  return response.json({ items, total: items.length })
})

phase4Router.get('/payments', requireOrganizationPermission('invoice:read'), async (request, response) => {
  const items = await prisma.payment.findMany({
    where: { invoice: { organizationId: request.auth!.organizationId } },
    orderBy: { createdAt: 'desc' }, take: 100,
    include: { invoice: { select: { id: true, invoiceNumber: true, currency: true, status: true } }, refunds: { orderBy: { createdAt: 'desc' } } },
  })
  return response.json({ items, total: items.length })
})

phase4Router.get('/refunds', requireOrganizationPermission('invoice:read'), async (request, response) => {
  const items = await prisma.refund.findMany({
    where: { payment: { invoice: { organizationId: request.auth!.organizationId } } },
    orderBy: { createdAt: 'desc' }, take: 100,
    include: { payment: { select: { id: true, amount: true, currency: true, status: true, invoice: { select: { id: true, invoiceNumber: true } } } } },
  })
  return response.json({ items, total: items.length })
})

phase4Router.post('/invoices', requireOrganizationPermission('invoice:create'), async (request, response) => {
  const parsed = createInvoiceSchema.safeParse(request.body)
  if (!parsed.success) return response.status(400).json({ message: 'Invalid invoice details', issues: parsed.error.issues })
  const subtotal = parsed.data.items.reduce((total, item) => total.add(new Prisma.Decimal(item.unitPrice).mul(item.quantity)), new Prisma.Decimal(0)).toDecimalPlaces(2)
  const invoice = await prisma.$transaction(async (tx) => {
    const created = await tx.invoice.create({
      data: {
        invoiceNumber: `TT-INV-${randomUUID().toUpperCase()}`, organizationId: request.auth!.organizationId,
        createdById: request.auth!.userId, currency: parsed.data.currency, subtotal, total: subtotal,
        items: { create: parsed.data.items.map((item) => ({ ...item, unitPrice: new Prisma.Decimal(item.unitPrice) })) },
      }, include: invoiceInclude,
    })
    await audit(tx, { organizationId: request.auth!.organizationId, actorId: request.auth!.userId, action: 'INVOICE_CREATED', resourceType: 'Invoice', resourceId: created.id, metadata: { invoiceNumber: created.invoiceNumber, itemCount: created.items.length, total: created.total.toString(), currency: created.currency } })
    return created
  })
  return response.status(201).json(invoice)
})

phase4Router.get('/invoices/:id', requireOrganizationPermission('invoice:read'), async (request, response) => {
  const id = uuidSchema.safeParse(request.params.id)
  if (!id.success) return response.status(400).json({ message: 'A valid invoice ID is required' })
  const invoice = await prisma.invoice.findFirst({ where: { id: id.data, organizationId: request.auth!.organizationId }, include: invoiceInclude })
  if (!invoice) return response.status(404).json({ message: 'Invoice not found' })
  return response.json(invoice)
})

phase4Router.post('/invoices/:id/issue', requireOrganizationPermission('invoice:update'), async (request, response) => {
  const id = uuidSchema.safeParse(request.params.id)
  if (!id.success) return response.status(400).json({ message: 'A valid invoice ID is required' })
  const result = await prisma.$transaction(async (tx) => {
    const invoice = await tx.invoice.findFirst({ where: { id: id.data, organizationId: request.auth!.organizationId } })
    if (!invoice) return { kind: 'not-found' as const }
    if (invoice.status !== 'DRAFT') return { kind: 'invalid-state' as const }
    const updated = await tx.invoice.update({ where: { id: invoice.id }, data: { status: 'ISSUED' } })
    await audit(tx, { organizationId: request.auth!.organizationId, actorId: request.auth!.userId, action: 'INVOICE_ISSUED', resourceType: 'Invoice', resourceId: invoice.id })
    return { kind: 'ok' as const, invoice: updated }
  })
  if (result.kind === 'not-found') return response.status(404).json({ message: 'Invoice not found' })
  if (result.kind === 'invalid-state') return response.status(409).json({ message: 'Only draft invoices can be issued' })
  return response.json(result.invoice)
})

const paymentSchema = z.object({ amount: moneySchema.refine((value) => new Prisma.Decimal(value).greaterThan(0)), method: z.enum(['CASH', 'BANK_TRANSFER', 'CHEQUE', 'OTHER']), reference: z.string().trim().max(120).optional() }).strict()
phase4Router.post('/invoices/:id/payments', requireOrganizationPermission('invoice:update'), async (request, response) => {
  const id = uuidSchema.safeParse(request.params.id)
  const parsed = paymentSchema.safeParse(request.body)
  if (!id.success || !parsed.success) return response.status(400).json({ message: 'Invalid payment details' })
  const result = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Invoice" WHERE "id" = ${id.data}::uuid FOR UPDATE`
    const invoice = await tx.invoice.findFirst({ where: { id: id.data, organizationId: request.auth!.organizationId } })
    if (!invoice) return { kind: 'not-found' as const }
    if (!['ISSUED', 'PARTIALLY_PAID', 'OVERDUE'].includes(invoice.status)) return { kind: 'invalid-state' as const }
    const previous = await tx.payment.findMany({ where: { invoiceId: invoice.id, status: { in: [PaymentStatus.PAID, PaymentStatus.PARTIALLY_REFUNDED] } }, include: { refunds: true } })
    const paid = previous.reduce((total, payment) => total.add(payment.amount).sub(payment.refunds.reduce((refunded, refund) => refunded.add(refund.amount), new Prisma.Decimal(0))), new Prisma.Decimal(0))
    if (new Prisma.Decimal(parsed.data.amount).greaterThan(invoice.total.sub(paid))) return { kind: 'amount-exceeded' as const }
    const payment = await tx.payment.create({ data: { invoiceId: invoice.id, amount: new Prisma.Decimal(parsed.data.amount), currency: invoice.currency, status: PaymentStatus.PAID, method: parsed.data.method, providerRef: parsed.data.reference, recordedById: request.auth!.userId } })
    const newPaid = paid.add(payment.amount)
    await tx.invoice.update({ where: { id: invoice.id }, data: { status: newPaid.greaterThanOrEqualTo(invoice.total) ? 'PAID' : 'PARTIALLY_PAID' } })
    await audit(tx, { organizationId: request.auth!.organizationId, actorId: request.auth!.userId, action: 'PAYMENT_RECORDED', resourceType: 'Payment', resourceId: payment.id, metadata: { invoiceId: invoice.id, amount: payment.amount.toString(), currency: payment.currency, method: payment.method ?? 'OTHER' } })
    await notifyOrganization(tx, request.auth!.organizationId, 'Invoice payment recorded', `A payment was recorded for ${invoice.invoiceNumber}.`)
    return { kind: 'ok' as const, payment }
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
  if (result.kind === 'not-found') return response.status(404).json({ message: 'Invoice not found' })
  if (result.kind === 'invalid-state') return response.status(409).json({ message: 'Invoice must be issued before recording a payment' })
  if (result.kind === 'amount-exceeded') return response.status(409).json({ message: 'Payment exceeds the outstanding invoice balance' })
  return response.status(201).json(result.payment)
})

const refundSchema = z.object({ amount: moneySchema.refine((value) => new Prisma.Decimal(value).greaterThan(0)), reason: z.string().trim().min(2).max(500) }).strict()
phase4Router.post('/payments/:id/refunds', requireOrganizationPermission('invoice:update'), async (request, response) => {
  const id = uuidSchema.safeParse(request.params.id)
  const parsed = refundSchema.safeParse(request.body)
  if (!id.success || !parsed.success) return response.status(400).json({ message: 'Invalid refund details' })
  const result = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Payment" WHERE "id" = ${id.data}::uuid FOR UPDATE`
    const payment = await tx.payment.findFirst({ where: { id: id.data, invoice: { organizationId: request.auth!.organizationId } }, include: { refunds: true, invoice: true } })
    if (!payment || payment.status === PaymentStatus.PENDING || payment.status === PaymentStatus.FAILED) return { kind: 'not-found' as const }
    const refunded = payment.refunds.reduce((total, item) => total.add(item.amount), new Prisma.Decimal(0))
    const amount = new Prisma.Decimal(parsed.data.amount)
    if (amount.greaterThan(payment.amount.sub(refunded))) return { kind: 'amount-exceeded' as const }
    const refund = await tx.refund.create({ data: { paymentId: payment.id, amount, reason: parsed.data.reason, createdById: request.auth!.userId } })
    const totalRefunded = refunded.add(amount)
    await tx.payment.update({ where: { id: payment.id }, data: { status: totalRefunded.greaterThanOrEqualTo(payment.amount) ? PaymentStatus.REFUNDED : PaymentStatus.PARTIALLY_REFUNDED } })
    const invoicePayments = await tx.payment.findMany({ where: { invoiceId: payment.invoiceId, status: { in: [PaymentStatus.PAID, PaymentStatus.PARTIALLY_REFUNDED] } }, include: { refunds: true } })
    const netPaid = invoicePayments.reduce((total, entry) => total.add(entry.amount).sub(entry.refunds.reduce((sum, item) => sum.add(item.amount), new Prisma.Decimal(0))), new Prisma.Decimal(0))
    const invoiceStatus = netPaid.isZero() ? 'ISSUED' : netPaid.greaterThanOrEqualTo(payment.invoice.total) ? 'PAID' : 'PARTIALLY_PAID'
    await tx.invoice.update({ where: { id: payment.invoiceId }, data: { status: invoiceStatus } })
    await audit(tx, { organizationId: request.auth!.organizationId, actorId: request.auth!.userId, action: 'REFUND_RECORDED', resourceType: 'Refund', resourceId: refund.id, metadata: { paymentId: payment.id, invoiceId: payment.invoiceId, amount: refund.amount.toString(), currency: payment.currency } })
    await notifyOrganization(tx, request.auth!.organizationId, 'Refund recorded', `A refund was recorded for ${payment.invoice.invoiceNumber}.`)
    return { kind: 'ok' as const, refund }
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable })
  if (result.kind === 'not-found') return response.status(404).json({ message: 'Eligible payment not found in this organization' })
  if (result.kind === 'amount-exceeded') return response.status(409).json({ message: 'Refund exceeds the remaining refundable payment amount' })
  return response.status(201).json(result.refund)
})

phase4Router.get('/notifications/unread-count', requireOrganizationPermission('notification:read'), async (request, response) => {
  const count = await prisma.notification.count({ where: { organizationId: request.auth!.organizationId, userId: request.auth!.userId, readAt: null } })
  return response.json({ unread: count })
})

phase4Router.get('/notifications', requireOrganizationPermission('notification:read'), async (request, response) => {
  const items = await prisma.notification.findMany({ where: { organizationId: request.auth!.organizationId, userId: request.auth!.userId }, orderBy: { createdAt: 'desc' }, take: 50 })
  return response.json({ items, unread: items.filter(({ readAt }) => !readAt).length })
})

phase4Router.patch('/notifications/read-all', requireOrganizationPermission('notification:update'), async (request, response) => {
  const result = await prisma.notification.updateMany({ where: { organizationId: request.auth!.organizationId, userId: request.auth!.userId, readAt: null }, data: { readAt: new Date() } })
  return response.json({ updated: result.count })
})

phase4Router.patch('/notifications/:id/read', requireOrganizationPermission('notification:update'), async (request, response) => {
  const id = uuidSchema.safeParse(request.params.id)
  if (!id.success) return response.status(400).json({ message: 'A valid notification ID is required' })
  const notification = await prisma.notification.updateMany({ where: { id: id.data, organizationId: request.auth!.organizationId, userId: request.auth!.userId }, data: { readAt: new Date() } })
  if (!notification.count) return response.status(404).json({ message: 'Notification not found' })
  return response.json({ id: id.data, read: true })
})

phase4Router.get('/reports/operations', requireOrganizationPermission('report:read'), async (request, response) => {
  const organizationId = request.auth!.organizationId
  const now = new Date()
  const [products, batchCount, batchStatuses, inventory, activeShipments, deliveredShipments, returnStatuses, recalledBatches, expiredBatches, invoiceCount, invoiceTotals, payments, recentActivity, activity] = await Promise.all([
    prisma.product.count({ where: { organizationId, domain: 'PHARMACEUTICAL' } }),
    prisma.batch.count({ where: { product: { organizationId, domain: 'PHARMACEUTICAL' } } }),
    prisma.batch.groupBy({ by: ['status'], where: { product: { organizationId, domain: 'PHARMACEUTICAL' } }, _count: { _all: true } }),
    prisma.inventory.aggregate({ where: { batch: { product: { organizationId, domain: 'PHARMACEUTICAL' } } }, _sum: { onHand: true, reserved: true } }),
    prisma.shipment.count({ where: { organizationId, status: { notIn: ['DELIVERED', 'CANCELLED'] } } }),
    prisma.shipment.count({ where: { organizationId, status: 'DELIVERED' } }),
    prisma.return.groupBy({ by: ['status'], where: { organizationId }, _count: { _all: true } }),
    prisma.batch.count({ where: { product: { organizationId }, OR: [{ status: 'RECALLED' }, { recalled: { gt: 0 } }] } }),
    prisma.batch.count({ where: { product: { organizationId }, expiryDate: { lt: now }, status: { notIn: ['RECALLED', 'DISPOSED'] } } }),
    prisma.invoice.count({ where: { organizationId } }),
    prisma.invoice.groupBy({ by: ['currency'], where: { organizationId }, _sum: { total: true }, _count: { _all: true } }),
    prisma.payment.findMany({ where: { invoice: { organizationId }, status: { in: [PaymentStatus.PAID, PaymentStatus.PARTIALLY_REFUNDED, PaymentStatus.REFUNDED] } }, select: { amount: true, currency: true, refunds: { select: { amount: true } } } }),
    prisma.supplyChainEvent.findMany({ where: { organizationId }, orderBy: { createdAt: 'desc' }, take: 8, include: { product: { select: { name: true } }, actor: { select: { fullName: true } } } }),
    prisma.$queryRaw<Array<{ day: Date; events: number; anchors: number }>>`SELECT date_trunc('day', event."createdAt") AS day, COUNT(*)::int AS events, COUNT(*) FILTER (WHERE anchor.status = 'ANCHORED')::int AS anchors FROM "SupplyChainEvent" event LEFT JOIN "TraceabilityAnchor" anchor ON anchor."eventId" = event.id WHERE event."organizationId" = ${organizationId}::uuid AND event."createdAt" >= now() - interval '14 days' GROUP BY 1 ORDER BY 1`,
  ])
  return response.json({
    products, batchCount, batchStatuses: batchStatuses.map(({ status, _count }) => ({ status, count: _count._all })),
    inventory: { onHand: inventory._sum.onHand ?? 0, reserved: inventory._sum.reserved ?? 0 },
    activeShipments, deliveredShipments,
    returnsByStatus: returnStatuses.map(({ status, _count }) => ({ status, count: _count._all })),
    recalledBatches, expiredBatches, invoiceCount,
    invoices: {
      count: invoiceCount,
      paid: invoiceTotals.map((group) => {
        const currencyPayments = payments.filter((payment) => payment.currency === group.currency)
        const netPaid = currencyPayments.reduce((total, payment) => total.add(payment.amount).sub(payment.refunds.reduce((sum, refund) => sum.add(refund.amount), new Prisma.Decimal(0))), new Prisma.Decimal(0))
        return `${group.currency} ${netPaid.toFixed(2)}`
      }).join(' · ') || '—',
    },
    invoiceSummary: invoiceTotals.map((group) => {
      const currencyPayments = payments.filter((payment) => payment.currency === group.currency)
      const netPaid = currencyPayments.reduce((total, payment) => total.add(payment.amount).sub(payment.refunds.reduce((sum, refund) => sum.add(refund.amount), new Prisma.Decimal(0))), new Prisma.Decimal(0))
      return { currency: group.currency, invoiceCount: group._count._all, total: group._sum.total ?? new Prisma.Decimal(0), netPaid }
    }),
    recentActivity: recentActivity.map((event) => ({ id: event.id, eventType: event.eventType, productName: event.product.name, actorName: event.actor?.fullName ?? 'System', createdAt: event.createdAt })),
    activity: activity.map((row) => ({ ...row, day: row.day.toISOString() })),
  })
})

phase4Router.get('/audit-logs', requireOrganizationPermission('audit:read'), async (request, response) => {
  const items = await prisma.auditLog.findMany({
    where: { organizationId: request.auth!.organizationId }, orderBy: { createdAt: 'desc' }, take: 100,
    include: { actor: { select: { id: true, fullName: true, email: true } } },
  })
  return response.json({ items, total: items.length })
})