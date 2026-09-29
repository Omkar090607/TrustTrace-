import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../lib/prisma.js'
import { authenticate, requireOrganization, requireOrganizationPermission } from '../middleware/auth.js'
import { appendSupplyChainEvent } from '../services/append-event.js'

export const inventoryRouter = Router()
inventoryRouter.use(authenticate, requireOrganization)
class InventoryTransferConflictError extends Error {}

const receiveSchema = z.object({
  batchId: z.string().uuid(),
  locationName: z.string().trim().min(2).max(180),
  quantity: z.number().int().positive().max(1000000000),
}).strict()
const transferSchema = z.object({
  batchId: z.string().uuid(),
  fromLocationId: z.string().uuid(),
  toLocationId: z.string().uuid(),
  quantity: z.number().int().positive().max(1000000000),
}).strict()

inventoryRouter.get('/', requireOrganizationPermission('inventory:read'), async (request, response) => {
  const rows = await prisma.inventory.findMany({
    where: { batch: { product: { organizationId: request.auth!.organizationId, domain: 'PHARMACEUTICAL' } } },
    orderBy: [{ location: { name: 'asc' } }, { batch: { batchNumber: 'asc' } }],
    include: {
      location: { select: { id: true, name: true } },
      batch: { include: { product: { include: { identity: true } } } },
    },
  })
  const items = rows.map(({ batch, location, onHand, reserved, updatedAt, id }) => ({
    id,
    batchId: batch.id,
    batchNumber: batch.batchNumber,
    productId: batch.product.id,
    productName: batch.product.name,
    traceId: batch.product.identity?.traceId ?? null,
    locationId: location.id,
    locationName: location.name,
    onHand,
    reserved,
    available: Math.max(0, onHand - reserved),
    updatedAt,
  }))
  return response.json({ items, total: items.length })
})

inventoryRouter.post('/receive', requireOrganizationPermission('inventory:manage'), async (request, response) => {
  const parsed = receiveSchema.safeParse(request.body)
  if (!parsed.success) return response.status(400).json({ message: 'Invalid inventory receipt details', issues: parsed.error.issues.map((issue) => ({ field: issue.path.join('.'), message: issue.message })) })
  const input = parsed.data

  const result = await prisma.$transaction(async (transaction) => {
    const batch = await transaction.batch.findFirst({
      where: { id: input.batchId, product: { organizationId: request.auth!.organizationId, domain: 'PHARMACEUTICAL' } },
    })
    if (!batch) return { kind: 'not-found' as const }
    if (batch.qualityStatus !== 'PASSED' || batch.status !== 'APPROVED' && batch.status !== 'IN_WAREHOUSE') return { kind: 'not-approved' as const }
    if (batch.expiryDate <= new Date()) return { kind: 'expired' as const }

    const location = await transaction.inventoryLocation.findFirst({ where: { organizationId: request.auth!.organizationId, name: input.locationName } })
      ?? await transaction.inventoryLocation.create({ data: { organizationId: request.auth!.organizationId, name: input.locationName } })
    const inventory = await transaction.inventory.upsert({
      where: { batchId_locationId: { batchId: batch.id, locationId: location.id } },
      create: { batchId: batch.id, locationId: location.id, onHand: input.quantity, reserved: 0 },
      update: { onHand: { increment: input.quantity } },
    })
    await transaction.batch.update({ where: { id: batch.id }, data: { available: { increment: input.quantity }, status: 'IN_WAREHOUSE', storageLocationId: location.id } })
    await transaction.inventoryMovement.create({
      data: { batchId: batch.id, locationId: location.id, quantity: input.quantity, reason: 'WAREHOUSE_RECEIVED', actorId: request.auth!.userId },
    })
    await appendSupplyChainEvent(transaction, {
      productId: batch.productId,
      batchId: batch.id,
      actorId: request.auth!.userId,
      organizationId: request.auth!.organizationId,
      locationId: location.id,
      eventType: 'WAREHOUSE_RECEIVED',
      quantity: input.quantity,
      metadata: { locationName: location.name },
    })
    return { kind: 'ok' as const, inventory, location, batchNumber: batch.batchNumber }
  })

  if (result.kind === 'not-found') return response.status(404).json({ message: 'Batch not found in this organization' })
  if (result.kind === 'not-approved') return response.status(409).json({ message: 'Only quality-approved batches can be received into inventory' })
  if (result.kind === 'expired') return response.status(409).json({ message: 'Expired batches cannot be received into normal inventory' })
  return response.status(201).json({
    id: result.inventory.id,
    batchId: result.inventory.batchId,
    batchNumber: result.batchNumber,
    locationId: result.location.id,
    locationName: result.location.name,
    onHand: result.inventory.onHand,
    reserved: result.inventory.reserved,
    available: Math.max(0, result.inventory.onHand - result.inventory.reserved),
  })
})

inventoryRouter.post('/transfer', requireOrganizationPermission('inventory:manage'), async (request, response) => {
  const parsed = transferSchema.safeParse(request.body)
  if (!parsed.success) return response.status(400).json({ message: 'Invalid inventory transfer details', issues: parsed.error.issues.map((issue) => ({ field: issue.path.join('.'), message: issue.message })) })
  const input = parsed.data
  if (input.fromLocationId === input.toLocationId) return response.status(400).json({ message: 'Source and destination locations must differ' })

  let result
  try {
    result = await prisma.$transaction(async (transaction) => {
    const batch = await transaction.batch.findFirst({ where: { id: input.batchId, product: { organizationId: request.auth!.organizationId, domain: 'PHARMACEUTICAL' } } })
    if (!batch) return { kind: 'not-found' as const }
    if (batch.qualityStatus !== 'PASSED' || batch.status === 'QUARANTINED' || batch.status === 'RECALLED' || batch.status === 'DISPOSED') return { kind: 'blocked' as const }
    const [source, destination] = await Promise.all([
      transaction.inventoryLocation.findFirst({ where: { id: input.fromLocationId, organizationId: request.auth!.organizationId } }),
      transaction.inventoryLocation.findFirst({ where: { id: input.toLocationId, organizationId: request.auth!.organizationId } }),
    ])
    if (!source || !destination) return { kind: 'location-not-found' as const }
    const sourceInventory = await transaction.inventory.findUnique({ where: { batchId_locationId: { batchId: batch.id, locationId: source.id } } })
    if (!sourceInventory || sourceInventory.onHand - sourceInventory.reserved < input.quantity) return { kind: 'insufficient' as const }
    const deducted = await transaction.inventory.updateMany({
      where: { id: sourceInventory.id, onHand: { gte: sourceInventory.reserved + input.quantity } },
      data: { onHand: { decrement: input.quantity } },
    })
    if (deducted.count !== 1) throw new InventoryTransferConflictError()
    const destinationInventory = await transaction.inventory.upsert({
      where: { batchId_locationId: { batchId: batch.id, locationId: destination.id } },
      create: { batchId: batch.id, locationId: destination.id, onHand: input.quantity, reserved: 0 },
      update: { onHand: { increment: input.quantity } },
    })
    await transaction.inventoryMovement.createMany({ data: [
      { batchId: batch.id, locationId: source.id, quantity: -input.quantity, reason: 'INVENTORY_TRANSFER_OUT', actorId: request.auth!.userId },
      { batchId: batch.id, locationId: destination.id, quantity: input.quantity, reason: 'INVENTORY_TRANSFER_IN', actorId: request.auth!.userId },
    ] })
    await appendSupplyChainEvent(transaction, {
      productId: batch.productId,
      batchId: batch.id,
      actorId: request.auth!.userId,
      organizationId: request.auth!.organizationId,
      locationId: destination.id,
      eventType: 'INVENTORY_TRANSFER',
      quantity: input.quantity,
      metadata: { fromLocation: source.name, toLocation: destination.name },
    })
      return { kind: 'ok' as const, inventory: destinationInventory, location: destination }
    })
  } catch (error) {
    if (error instanceof InventoryTransferConflictError) return response.status(409).json({ message: 'Inventory changed during transfer; reload and retry' })
    throw error
  }

  if (result.kind === 'not-found') return response.status(404).json({ message: 'Batch not found in this organization' })
  if (result.kind === 'location-not-found') return response.status(404).json({ message: 'Inventory location not found in this organization' })
  if (result.kind === 'blocked') return response.status(409).json({ message: 'Only approved, non-recalled batches can be transferred' })
  if (result.kind === 'insufficient') return response.status(409).json({ message: 'Insufficient unreserved inventory for this transfer' })
  return response.json({
    batchId: result.inventory.batchId,
    locationId: result.location.id,
    locationName: result.location.name,
    onHand: result.inventory.onHand,
    reserved: result.inventory.reserved,
    available: Math.max(0, result.inventory.onHand - result.inventory.reserved),
  })
})
