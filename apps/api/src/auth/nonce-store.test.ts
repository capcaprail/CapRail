import type { WalletAddress } from '@caprail/shared'
import { describe, expect, it } from 'vitest'
import { memoryNonceStore } from './nonce-store.ts'

const WALLET = 'As8C4JwSGHd7HPvh5KD1FhhLsQphQ8veSdhipiSRWs7g' as WalletAddress
const T0 = new Date('2026-09-12T12:00:00Z')
const later = (ms: number) => new Date(T0.getTime() + ms)

describe('memoryNonceStore', () => {
  it('consumes once, refuses a replay, an expired and a replaced nonce', async () => {
    const store = memoryNonceStore()
    await store.issue(WALLET, 'a'.repeat(32), later(1000))
    expect(await store.consume(WALLET, 'a'.repeat(32), T0)).toBe(true)
    expect(await store.consume(WALLET, 'a'.repeat(32), T0)).toBe(false)

    await store.issue(WALLET, 'b'.repeat(32), later(1000))
    expect(await store.consume(WALLET, 'b'.repeat(32), later(1000))).toBe(false)

    await store.issue(WALLET, 'c'.repeat(32), later(1000))
    await store.issue(WALLET, 'd'.repeat(32), later(1000))
    expect(await store.consume(WALLET, 'c'.repeat(32), T0)).toBe(false)
    expect(await store.consume(WALLET, 'd'.repeat(32), T0)).toBe(true)
  })
})
