import type { FeedEvent } from '@caprail/shared'
import { describe, expect, it } from 'vitest'
import { createFeed, type FeedSource } from './feed.ts'
import { memoryIndexReader } from './memory-reader.ts'
import type { FeedMarks } from './reader.ts'
import { seed } from './test-seed.ts'

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms))

describe('createFeed', () => {
  it('starts from the current marks and delivers what lands afterwards', async () => {
    const data = seed()
    const reader = memoryIndexReader(data.index)
    const calls: string[] = []
    const feed = createFeed({
      source: (id, since) => {
        calls.push(since === null ? 'marks' : 'poll')
        return reader.feed({ companyId: id }, id, since)
      },
      intervalMs: 5,
      onError: () => {},
    })
    const seen: FeedEvent[] = []
    const unsubscribe = feed.subscribe(data.companyId, (event) => seen.push(event))
    await tick(12)
    // Three attempts, two statuses and two policies were already there: none replayed.
    expect(seen).toEqual([])
    expect(calls[0]).toBe('marks')

    await reader.reportAttempt(
      { companyId: data.companyId },
      {
        mint: data.mint,
        sourceOwner: data.alice,
        destOwner: data.stranger,
        amount: '1',
        reasonCode: 'NotAccredited',
        logs: [],
      },
      data.alice,
      new Date(),
    )
    const alice = data.index.investors[0]
    if (alice === undefined) throw new Error('seed has no investor')
    data.index.statusEvents.push({
      id: 3n,
      companyId: data.companyId,
      investor: { ...alice, status: 'revoked' },
    })
    data.index.policyVersions.push({
      companyId: data.companyId,
      mint: data.mint,
      version: 3,
      slot: 50n,
      policy: { requireAccreditation: false, requireRofr: false, rofrWindowSecs: 0 },
      setAt: null,
    })
    await tick(12)
    expect(seen.map((e) => e.kind)).toEqual(['attempt', 'status', 'policy'])
    const attempt = seen[0]
    if (attempt?.kind !== 'attempt') throw new Error('expected an attempt')
    expect(attempt.entry.origin).toBe('simulation')
    // Delivered once: the marks moved past them.
    await tick(12)
    expect(seen).toHaveLength(3)
    unsubscribe()
    expect(feed.active()).toEqual([])
  })

  it('shares one poller between streams of a company and stops with the last', async () => {
    let polls = 0
    const feed = createFeed({
      source: () => {
        polls += 1
        return Promise.resolve({
          events: [],
          marks: { attemptId: 0n, statusEventId: 0n, policySlot: 0n, policyKeys: [] },
        })
      },
      intervalMs: 5,
      onError: () => {},
    })
    const a = feed.subscribe('1', () => {})
    const b = feed.subscribe('1', () => {})
    const c = feed.subscribe('2', () => {})
    await tick(12)
    expect(feed.active().sort()).toEqual(['1', '2'])
    const after = polls
    a()
    b()
    c()
    expect(feed.active()).toEqual([])
    await tick(12)
    expect(polls).toBe(after)
  })

  it('carries the marks from one poll to the next', async () => {
    const seen: (FeedMarks | null)[] = []
    const marks = (attemptId: bigint): FeedMarks => ({
      attemptId,
      statusEventId: 0n,
      policySlot: 0n,
      policyKeys: [],
    })
    const source: FeedSource = (_, since) => {
      seen.push(since)
      return Promise.resolve({ events: [], marks: marks(BigInt(seen.length)) })
    }
    const feed = createFeed({ source, intervalMs: 3, onError: () => {} })
    const stop = feed.subscribe('1', () => {})
    await tick(20)
    stop()
    expect(seen[0]).toBeNull()
    expect(seen[1]).toEqual(marks(1n))
    expect(seen[2]).toEqual(marks(2n))
  })

  it('reports a failing poll and keeps polling', async () => {
    let calls = 0
    const errors: unknown[] = []
    const feed = createFeed({
      source: () => {
        calls += 1
        return calls === 1
          ? Promise.reject(new Error('db down'))
          : Promise.resolve({
              events: [],
              marks: { attemptId: 0n, statusEventId: 0n, policySlot: 0n, policyKeys: [] },
            })
      },
      intervalMs: 3,
      onError: (err) => errors.push(err),
    })
    const stop = feed.subscribe('1', () => {})
    await tick(15)
    stop()
    expect(errors).toHaveLength(1)
    expect(calls).toBeGreaterThan(1)
  })
})
