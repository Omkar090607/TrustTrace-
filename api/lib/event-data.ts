export function eventDataFromRecord(event: {
  id: string
  eventType: string
  productId: string
  batchId: string | null
  packageId: string | null
  actorId: string | null
  organizationId: string | null
  locationId: string | null
  timestamp: Date
  quantity: number | null
  metadata: unknown
  createdAt: Date
}) {
  return {
    eventId: event.id,
    eventType: event.eventType,
    productId: event.productId,
    batchId: event.batchId,
    packageId: event.packageId,
    actorId: event.actorId,
    organizationId: event.organizationId,
    locationId: event.locationId,
    timestamp: event.timestamp.toISOString(),
    quantity: event.quantity,
    metadata: event.metadata,
    createdAt: event.createdAt.toISOString(),
  }
}
