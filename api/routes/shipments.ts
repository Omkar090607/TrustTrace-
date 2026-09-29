import { randomUUID } from 'node:crypto'
import { Router } from 'express'
import { Prisma, ShipmentStatus } from '@prisma/client'
import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { authenticate, requireOrganization, requireOrganizationPermission } from '../middleware/auth.js'
import { appendSupplyChainEvent } from '../services/append-event.js'
import { notifyOrganizationMembers } from '../services/operational-records.js'

export const shipmentsRouter = Router()
shipmentsRouter.use(authenticate, requireOrganization)

const shipmentIdSchema = z.string().uuid()
const createShipmentSchema = z.object({
  destination: z.string().trim().min(2).max(500),
  items: z.array(z.object({ batchId: z.string().uuid(), quantity: z.number().int().positive().max(1000000000) }).strict()).min(1).max(100),
}).strict().refine((value) => new Set(value.items.map((item) => item.batchId)).size === value.items.length, {
  path: ['items'],
  message: 'Each batch may only appear once in a shipment',
})
const advanceSchema = z.object({ status: z.enum(['IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED']), note: z.string().trim().max(500).optional() }).strict()
const transitions: Partial<Record<ShipmentStatus, ShipmentStatus[]>> = {
  DISPATCHED: ['IN_TRANSIT'],
  IN_TRANSIT: ['OUT_FOR_DELIVERY'],
  OUT_FOR_DELIVERY: ['DELIVERED'],
}
class DispatchConflictError extends Error {}

const shipmentInclude = {
  items: { include: { batch: { include: { product: { include: { identity: true } } } } } },
  statusHistory: { orderBy: { occurredAt: 'asc' as const } },
}

function shipmentResponse(shipment: Prisma.ShipmentGetPayload<{ include: typeof shipmentInclude }>) {
  const destination = shipment.destination && typeof shipment.destination === 'object'
    ? shipment.destination as Record<string, unknown>
    : {}
  return {
    id: shipment.id,
    trackingNumber: shipment.trackingNumber,
    status: shipment.status,
    destination: destination.address ?? '',
    dispatchedAt: shipment.dispatchedAt,
    deliveredAt: shipment.deliveredAt,
    createdAt: shipment.createdAt,
    items: shipment.items.map(({ batch, quantity }) => ({
      batchId: batch.id,
      batchNumber: batch.batchNumber,
      productId: batch.product.id,
      productName: batch.product.name,
      traceId: batch.product.identity?.traceId ?? null,
      quantity,
    })),
    statusHistory: shipment.statusHistory,
  }
}

shipmentsRouter.get('/', requireOrganizationPermission('shipment:read'), async (request, response) => {
  const shipments = await prisma.shipment.findMany({
    where: { organizationId: request.auth!.organizationId },
    orderBy: { createdAt: 'desc' },
    take: 100,
    include: shipmentInclude,
  })
  return response.json({ items: shipments.map(shipmentResponse), total: shipments.length })
})

shipmentsRouter.post('/', requireOrganizationPermission('shipment:create'), async (request, response) => {
  const parsed = createShipmentSchema.safeParse(request.body)
  if (!parsed.success) return response.status(400).json({ message: 'Invalid shipment details', issues: parsed.error.issues.map((issue) => ({ field: issue.path.join('.'), message: issue.message })) })
  const batchIds = parsed.data.items.map((item) => item.batchId)
  const batches = await prisma.batch.findMany({
    where: { id: { in: batchIds }, product: { organizationId: request.auth!.organizationId, domain: 'PHARMACEUTICAL' } },
    select: { id: true },
  })
  if (batches.length !== batchIds.length) return response.status(404).json({ message: 'One or more batches were not found in this organization' })

  const trackingNumber = `TT-SHIP-${randomUUID().toUpperCase()}`
  const shipment = await prisma.$transaction(async (transaction) => {
    const created = await transaction.shipment.create({
      data: {
        trackingNumber,
        organizationId: request.auth!.organizationId,
        status: 'DRAFT',
        destination: { address: parsed.data.destination },
        items: { create: parsed.data.items },
        statusHistory: { create: { status: 'DRAFT', note: 'Shipment created' } },
      },
      include: shipmentInclude,
    })
    return created
  })
  return response.status(201).json(shipmentResponse(shipment))
})

shipmentsRouter.get('/:id', requireOrganizationPermission('shipment:read'), async (request, response) => {
  const id = shipmentIdSchema.safeParse(request.params.id)
  if (!id.success) return response.status(400).json({ message: 'A valid shipment ID is required' })
  const shipment = await prisma.shipment.findFirst({ where: { id: id.data, organizationId: request.auth!.organizationId }, include: shipmentInclude })
  if (!shipment) return response.status(404).json({ message: 'Shipment not found' })
  return response.json(shipmentResponse(shipment))
})

shipmentsRouter.post('/:id/dispatch', requireOrganizationPermission('shipment:update'), async (request, response) => {
  const id = shipmentIdSchema.safeParse(request.params.id)
  if (!id.success) return response.status(400).json({ message: 'A valid shipment ID is required' })

  let result
  try {
    result = await prisma.$transaction(async (transaction) => {
    const shipment = await transaction.shipment.findFirst({
      where: { id: id.data, organizationId: request.auth!.organizationId },
      include: { items: true },
    })
    if (!shipment) return { kind: 'not-found' as const }
    if (shipment.status !== 'DRAFT' && shipment.status !== 'READY') return { kind: 'invalid-state' as const }

    const preparedItems = []
    for (const item of shipment.items) {
      const batch = await transaction.batch.findFirst({
        where: { id: item.batchId, product: { organizationId: request.auth!.organizationId, domain: 'PHARMACEUTICAL' } },
      })
      if (!batch) return { kind: 'not-found' as const }
      if (batch.qualityStatus !== 'PASSED' || batch.status !== 'APPROVED' && batch.status !== 'IN_WAREHOUSE') return { kind: 'unapproved' as const }
      if (batch.expiryDate <= new Date()) return { kind: 'expired' as const }
      if (batch.recalled > 0 || await transaction.recallItem.findFirst({ where: { batchId: batch.id, recall: { status: 'ACTIVE' } }, select: { id: true } })) return { kind: 'recalled' as const }

      const stock = await transaction.inventory.findMany({
        where: { batchId: batch.id, location: { organizationId: request.auth!.organizationId } },
        orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
      })
      const available = stock.reduce((total, row) => total + Math.max(0, row.onHand - row.reserved), 0)
      if (batch.available < item.quantity || available < item.quantity) return { kind: 'insufficient' as const }
      preparedItems.push({ item, batch, stock })
    }

    for (const { item, batch, stock } of preparedItems) {
      let remaining = item.quantity
      for (const row of stock) {
        if (remaining <= 0) break
        const movable = Math.min(remaining, Math.max(0, row.onHand - row.reserved))
        if (movable <= 0) continue
        const deducted = await transaction.inventory.updateMany({
          where: { id: row.id, onHand: { gte: row.reserved + movable } },
          data: { onHand: { decrement: movable } },
        })
        if (deducted.count !== 1) throw new DispatchConflictError()
        await transaction.inventoryMovement.create({
          data: { batchId: batch.id, locationId: row.locationId, quantity: -movable, reason: `SHIPMENT_DISPATCHED:${shipment.trackingNumber}`, actorId: request.auth!.userId },
        })
        remaining -= movable
      }
      const batchUpdate = await transaction.batch.updateMany({
        where: { id: batch.id, available: { gte: item.quantity }, qualityStatus: 'PASSED', status: { in: ['APPROVED', 'IN_WAREHOUSE'] }, expiryDate: { gt: new Date() }, recalled: 0 },
        data: { available: { decrement: item.quantity }, dispatched: { increment: item.quantity }, status: 'DISPATCHED' },
      })
      if (batchUpdate.count !== 1) throw new DispatchConflictError()
      const firstLocation = stock[0]?.locationId
      await appendSupplyChainEvent(transaction, {
        productId: batch.productId,
        batchId: batch.id,
        actorId: request.auth!.userId,
        organizationId: request.auth!.organizationId,
        locationId: firstLocation,
        quantity: item.quantity,
        eventType: 'DISPATCHED',
        metadata: { trackingNumber: shipment.trackingNumber },
      })
    }

    const dispatchedAt = new Date()
    const updated = await transaction.shipment.update({
      where: { id: shipment.id },
      data: { status: 'DISPATCHED', dispatchedAt, statusHistory: { create: { status: 'DISPATCHED', note: 'Shipment dispatched' } } },
      include: shipmentInclude,
    })
    await notifyOrganizationMembers(transaction, request.auth!.organizationId, 'Shipment dispatched', `${shipment.trackingNumber} has been dispatched.`)
      return { kind: 'ok' as const, shipment: updated }
    })
  } catch (error) {
    if (error instanceof DispatchConflictError) return response.status(409).json({ message: 'Inventory or batch eligibility changed; reload and retry dispatch' })
    throw error
  }

  if (result.kind === 'not-found') return response.status(404).json({ message: 'Shipment or batch not found in this organization' })
  if (result.kind === 'invalid-state') return response.status(409).json({ message: 'Only draft or ready shipments can be dispatched' })
  if (result.kind === 'unapproved') return response.status(409).json({ message: 'All batches must pass quality approval before dispatch' })
  if (result.kind === 'expired') return response.status(409).json({ message: 'Expired batches cannot be dispatched' })
  if (result.kind === 'recalled') return response.status(409).json({ message: 'Recalled batches cannot be dispatched' })
  if (result.kind === 'insufficient') return response.status(409).json({ message: 'Insufficient unreserved inventory to dispatch this shipment' })
  return response.json(shipmentResponse(result.shipment))
})

shipmentsRouter.patch('/:id/status', requireOrganizationPermission('shipment:update'), async (request, response) => {
  const id = shipmentIdSchema.safeParse(request.params.id)
  const parsed = advanceSchema.safeParse(request.body)
  if (!id.success) return response.status(400).json({ message: 'A valid shipment ID is required' })
  if (!parsed.success) return response.status(400).json({ message: 'Invalid shipment status transition', issues: parsed.error.issues.map((issue) => ({ field: issue.path.join('.'), message: issue.message })) })

  const result = await prisma.$transaction(async (transaction) => {
    const shipment = await transaction.shipment.findFirst({
      where: { id: id.data, organizationId: request.auth!.organizationId },
      include: { items: { include: { batch: true } } },
    })
    if (!shipment) return { kind: 'not-found' as const }
    if (!transitions[shipment.status]?.includes(parsed.data.status)) return { kind: 'invalid-state' as const }
    const occurredAt = new Date()
    const updated = await transaction.shipment.update({
      where: { id: shipment.id },
      data: {
        status: parsed.data.status,
        deliveredAt: parsed.data.status === 'DELIVERED' ? occurredAt : undefined,
        statusHistory: { create: { status: parsed.data.status, note: parsed.data.note } },
      },
      include: shipmentInclude,
    })
    if (parsed.data.status === 'DELIVERED') await notifyOrganizationMembers(transaction, request.auth!.organizationId, 'Shipment delivered', `${shipment.trackingNumber} has been delivered.`)
    for (const item of shipment.items) {
      const eventType = parsed.data.status
      await appendSupplyChainEvent(transaction, {
        productId: item.batch.productId,
        batchId: item.batchId,
        actorId: request.auth!.userId,
        organizationId: request.auth!.organizationId,
        quantity: item.quantity,
        eventType,
        metadata: { trackingNumber: shipment.trackingNumber, note: parsed.data.note ?? '' },
      })
      if (parsed.data.status === 'DELIVERED') {
        const nextDelivered = item.batch.delivered + item.quantity
        const nextStatus = nextDelivered >= item.batch.dispatched
          ? item.batch.available > 0 ? 'IN_WAREHOUSE' : 'DELIVERED'
          : 'IN_TRANSIT'
        await transaction.batch.update({ where: { id: item.batchId }, data: { delivered: { increment: item.quantity }, status: nextStatus } })
      } else if (parsed.data.status === 'IN_TRANSIT' || parsed.data.status === 'OUT_FOR_DELIVERY') {
        await transaction.batch.update({ where: { id: item.batchId }, data: { status: parsed.data.status } })
      }
    }
    return { kind: 'ok' as const, shipment: updated }
  })

  if (result.kind === 'not-found') return response.status(404).json({ message: 'Shipment not found' })
  if (result.kind === 'invalid-state') return response.status(409).json({ message: 'Shipment status transition is not allowed' })
  return response.json(shipmentResponse(result.shipment))
})
