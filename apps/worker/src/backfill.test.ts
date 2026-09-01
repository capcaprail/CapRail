import type { ProgramTransaction } from '@caprail/indexer'
import { describe, expect, it } from 'vitest'
import { type BackfillRpc, backfill, type SignatureInfo } from './backfill.ts'

// Chain history, oldest first: s1 … sN with slot = index.
function history(count: number): SignatureInfo[] {
  return Array.from({ length: count }, (_, i) => ({ signature: `s${i + 1}`, slot: i + 1 }))
}

// Mimics getSignaturesForAddress: newest first, `before` exclusive, `until` exclusive.
function scripted(all: SignatureInfo[], missing: string[] = []) {
  const calls: { before?: string; until?: string; limit: number }[] = []
  const rpc: BackfillRpc = {
    signatures: (options) => {
      calls.push(options)
      const newestFirst = [...all].reverse()
      const start =
        options.before === undefined
          ? 0
          : newestFirst.findIndex((s) => s.signature === options.before) + 1
      const stop =
        options.until === undefined
          ? newestFirst.length
          : newestFirst.findIndex((s) => s.signature === options.until)
      return Promise.resolve(newestFirst.slice(start, stop).slice(0, options.limit))
    },
    transaction: (signature) => {
      if (missing.includes(signature)) return Promise.resolve(null)
      const info = all.find((s) => s.signature === signature)
      if (info === undefined) return Promise.resolve(null)
      return Promise.resolve({
        signature,
        slot: info.slot,
        blockTime: 1_700_000_000 + info.slot,
        logs: [`Program log: ${signature}`],
        failed: false,
      })
    },
  }
  return { rpc, calls }
}

describe('backfill', () => {
  it('replays everything after the cursor, oldest first, and returns the newest', async () => {
    const { rpc } = scripted(history(5))
    const seen: string[] = []
    const latest = await backfill(
      rpc,
      's2',
      (tx) => {
        seen.push(tx.signature)
        return Promise.resolve()
      },
      10,
    )
    expect(seen).toEqual(['s3', 's4', 's5'])
    expect(latest).toEqual({ signature: 's5', slot: 5 })
  })

  it('pages backwards with `before` until a short page', async () => {
    const { rpc, calls } = scripted(history(7))
    const seen: ProgramTransaction[] = []
    await backfill(
      rpc,
      null,
      (tx) => {
        seen.push(tx)
        return Promise.resolve()
      },
      3,
    )
    expect(calls.map((c) => c.before)).toEqual([undefined, 's5', 's2'])
    expect(seen.map((tx) => tx.signature)).toEqual(['s1', 's2', 's3', 's4', 's5', 's6', 's7'])
  })

  it('does nothing when the cursor is at the tip', async () => {
    const { rpc } = scripted(history(3))
    const latest = await backfill(rpc, 's3', () => Promise.reject(new Error('should not run')))
    expect(latest).toBeNull()
  })

  it('stops before a transaction the rpc does not serve, keeping the cursor behind it', async () => {
    const { rpc } = scripted(history(4), ['s3'])
    const seen: string[] = []
    const latest = await backfill(rpc, null, (tx) => {
      seen.push(tx.signature)
      return Promise.resolve()
    })
    expect(seen).toEqual(['s1', 's2'])
    expect(latest).toEqual({ signature: 's2', slot: 2 })
  })

  it('propagates a handler failure without advancing past it', async () => {
    const { rpc } = scripted(history(3))
    const seen: string[] = []
    await expect(
      backfill(rpc, null, (tx) => {
        seen.push(tx.signature)
        return tx.signature === 's2' ? Promise.reject(new Error('db down')) : Promise.resolve()
      }),
    ).rejects.toThrow('db down')
    expect(seen).toEqual(['s1', 's2'])
  })
})
