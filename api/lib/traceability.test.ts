import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { hashEvent, verifyHashChain } from './traceability.js'

describe('traceability hash chain', () => {
  it('verifies an intact single-event chain', () => {
    const eventData = { eventId: '1', eventType: 'CREATED', timestamp: '2026-01-01T00:00:00.000Z' }
    const currentHash = hashEvent(eventData, null)
    assert.equal(verifyHashChain([{ eventData, previousHash: null, currentHash }]), true)
  })

  it('detects modified event data and broken links', () => {
    const first = { eventId: '1', eventType: 'CREATED' }
    const firstHash = hashEvent(first, null)
    const second = { eventId: '2', eventType: 'DISPATCHED' }
    const secondHash = hashEvent(second, firstHash)
    assert.equal(verifyHashChain([
      { eventData: first, previousHash: null, currentHash: firstHash },
      { eventData: second, previousHash: firstHash, currentHash: secondHash },
    ]), true)
    assert.equal(verifyHashChain([
      { eventData: first, previousHash: null, currentHash: firstHash },
      { eventData: { ...second, eventType: 'DELIVERED' }, previousHash: firstHash, currentHash: secondHash },
    ]), false)
  })
})
