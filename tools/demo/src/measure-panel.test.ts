import { createPublicKey, verify } from 'node:crypto'
import type { JournalEntry } from '@caprail/shared'
import { Keypair } from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import {
  type Arrival,
  createFrameParser,
  latencies,
  latencyOf,
  percentile,
  signMessage,
  summarize,
} from './measure-panel.ts'
import type { Landed, Refused } from './send.ts'

const entry = (over: Partial<JournalEntry>): JournalEntry => ({
  id: '1',
  mint: 'mint',
  sourceOwner: 'alice',
  destOwner: 'bob',
  amount: '1',
  outcome: 'allowed',
  reasonCode: null,
  origin: 'chain',
  fromTreasury: false,
  policyVersion: 1,
  txSignature: 'sig',
  slot: 10,
  blockTime: '2026-09-14T00:00:00.000Z',
  logs: [],
  ...over,
})

const landed = (over: Partial<Landed>): Landed => ({
  signature: 'sig',
  slot: 10,
  blockTime: 1_000,
  confirmedAt: 1_000_500,
  feeLamports: 5000,
  computeUnits: 1,
  logs: [],
  accountKeys: [],
  transaction: { signature: 'sig', slot: 10, blockTime: 1_000, failed: false, logs: [] },
  ...over,
})

describe('createFrameParser', () => {
  it('splits frames on the blank line, across chunk boundaries', () => {
    const parser = createFrameParser()
    expect(parser.push('event: ready\ndata: {}\n\nevent: att')).toEqual([
      { event: 'ready', data: '{}' },
    ])
    expect(parser.push('empt\ndata: {"a":1}\n')).toEqual([])
    expect(parser.push('\n')).toEqual([{ event: 'attempt', data: '{"a":1}' }])
  })

  it('skips comments, defaults the event name and joins data lines', () => {
    const parser = createFrameParser()
    expect(parser.push(': keep-alive\ndata: a\ndata: b\n\n')).toEqual([
      { event: 'message', data: 'a\nb' },
    ])
  })

  it('keeps a ping with empty data as a frame', () => {
    expect(createFrameParser().push('event: ping\ndata: \n\n')).toEqual([
      { event: 'ping', data: '' },
    ])
  })
})

describe('percentile', () => {
  it('is nearest-rank', () => {
    const values = [5, 1, 4, 2, 3]
    expect(percentile(values, 50)).toBe(3)
    expect(percentile(values, 95)).toBe(5)
    expect(percentile(values, 100)).toBe(5)
    expect(percentile([7], 95)).toBe(7)
  })

  it('is NaN on nothing', () => {
    expect(percentile([], 95)).toBeNaN()
  })
})

describe('latencyOf', () => {
  const arrival: Arrival = { entry: entry({}), arrivedAt: 1_002_000 }

  it('measures from the client confirmation and from the block time', () => {
    const latency = latencyOf(landed({}), arrival, { outcome: 'allowed', destOwner: 'bob' })
    expect(latency.sinceConfirmedMs).toBe(1_500)
    expect(latency.sinceBlockMs).toBe(2_000)
    expect(latency.faithful).toBe(true)
  })

  it('has no block latency without a block time', () => {
    expect(
      latencyOf(landed({ blockTime: undefined }), arrival, { outcome: 'allowed', destOwner: 'bob' })
        .sinceBlockMs,
    ).toBeUndefined()
  })

  it('is unfaithful when the journal names another destination or outcome', () => {
    expect(
      latencyOf(landed({}), arrival, { outcome: 'allowed', destOwner: 'carol' }).faithful,
    ).toBe(false)
    expect(latencyOf(landed({}), arrival, { outcome: 'rejected', destOwner: 'bob' }).faithful).toBe(
      false,
    )
  })

  it('requires the refusal reason from the logs on a rejected entry', () => {
    const refused: Refused = {
      ...landed({}),
      code: 6000,
      reason: 'NotAccredited',
      err: { InstructionError: [0, { Custom: 6000 }] },
    }
    const rejected = (reasonCode: string | null): Arrival => ({
      entry: entry({ outcome: 'rejected', reasonCode, destOwner: 'stranger' }),
      arrivedAt: 1_002_000,
    })
    const expect_ = { outcome: 'rejected' as const, destOwner: 'stranger' }
    expect(latencyOf(refused, rejected('NotAccredited'), expect_).faithful).toBe(true)
    expect(latencyOf(refused, rejected('AccreditationExpired'), expect_).faithful).toBe(false)
    expect(latencyOf(refused, rejected(null), expect_).faithful).toBe(false)
  })

  it('does not count a simulation row as the chain event', () => {
    const simulated: Arrival = { entry: entry({ origin: 'simulation' }), arrivedAt: 1_002_000 }
    expect(
      latencyOf(landed({}), simulated, { outcome: 'allowed', destOwner: 'bob' }).faithful,
    ).toBe(false)
  })
})

describe('latencies + summarize', () => {
  it('drops what never arrived and reports the counts', () => {
    const arrivals = new Map<string, Arrival>([
      ['a', { entry: entry({ txSignature: 'a' }), arrivedAt: 1_001_000 }],
      ['b', { entry: entry({ txSignature: 'b', destOwner: 'carol' }), arrivedAt: 1_003_000 }],
    ])
    const sent = ['a', 'b', 'c'].map((signature) => ({
      landed: landed({ signature }),
      expect: { outcome: 'allowed' as const, destOwner: 'bob' },
    }))
    const summary = summarize(latencies(sent, arrivals), sent.length)
    expect(summary).toEqual({
      sent: 3,
      arrived: 2,
      faithful: 1,
      p50Ms: 500,
      p95Ms: 2_500,
      maxMs: 2_500,
      p95SinceBlockMs: 3_000,
    })
  })

  it('has no block percentile when any block time is missing', () => {
    const arrivals = new Map<string, Arrival>([
      ['a', { entry: entry({ txSignature: 'a' }), arrivedAt: 1_001_000 }],
    ])
    const sent = [
      {
        landed: landed({ signature: 'a', blockTime: undefined }),
        expect: { outcome: 'allowed' as const, destOwner: 'bob' },
      },
    ]
    expect(summarize(latencies(sent, arrivals), 1).p95SinceBlockMs).toBeUndefined()
  })
})

describe('signMessage', () => {
  it('produces an ed25519 signature the wallet public key verifies', () => {
    const keypair = Keypair.generate()
    const message = 'CapRail sign-in\n\nWallet: x\nNonce: y'
    const signature = signMessage(keypair, message)
    expect(signature).toHaveLength(64)
    // SubjectPublicKeyInfo header for Ed25519, as the API's verifier builds it.
    const spki = Buffer.concat([
      Buffer.from([0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00]),
      Buffer.from(keypair.publicKey.toBytes()),
    ])
    const key = createPublicKey({ key: spki, format: 'der', type: 'spki' })
    expect(verify(null, Buffer.from(message), key, signature)).toBe(true)
    expect(verify(null, Buffer.from(`${message}!`), key, signature)).toBe(false)
  })
})
