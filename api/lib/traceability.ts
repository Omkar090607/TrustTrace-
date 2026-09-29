import { createHash } from 'node:crypto'

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, normalize(item)]),
    )
  }
  return value
}

export function canonicalize(value: unknown): string {
  return JSON.stringify(normalize(value))
}

export function hashEvent(eventData: Record<string, unknown>, previousHash: string | null): string {
  return createHash('sha256').update(`${canonicalize(eventData)}${previousHash ?? ''}`).digest('hex')
}

export function verifyHashChain(events: Array<{ currentHash: string; previousHash: string | null; eventData: Record<string, unknown> }>): boolean {
  let priorHash: string | null = null
  for (const event of events) {
    if (event.previousHash !== priorHash || hashEvent(event.eventData, priorHash) !== event.currentHash) return false
    priorHash = event.currentHash
  }
  return true
}
