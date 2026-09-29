import { ata } from '@caprail/chain'
import { PublicKey } from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import {
  assess,
  createStaleSweep,
  type OfferBook,
  type OpenOffer,
  type Reading,
  STALE_TTL_MS,
  type StaleRpc,
  type TokenAccountState,
} from './stale.ts'

const pk = (n: number) => new PublicKey(new Uint8Array(32).fill(n)).toBase58()
const MINT = pk(1)
const OFFER = pk(2)

const whole: TokenAccountState = {
  amount: 5_000n,
  delegate: OFFER,
  delegatedAmount: 3_000n,
  frozen: false,
}

describe('assess', () => {
  const offer = { offer: OFFER, remaining: 3_000n }

  it('passes an account that can deliver all of remaining', () => {
    expect(assess(offer, whole)).toEqual({ available: 3_000n, staleReason: null })
    // Delegated for more than is left (a partial fill does not over-shrink it).
    expect(assess({ ...offer, remaining: 1_000n }, whole)).toEqual({
      available: 1_000n,
      staleReason: null,
    })
  })

  it('names the first thing in the way, in the order accept_offer meets it', () => {
    expect(assess(offer, null)).toEqual({ available: 0n, staleReason: 'account_missing' })
    expect(assess(offer, { ...whole, frozen: true, delegate: null })).toEqual({
      available: 0n,
      staleReason: 'frozen',
    })
    expect(assess(offer, { ...whole, delegate: null })).toEqual({
      available: 0n,
      staleReason: 'not_delegated',
    })
    expect(assess(offer, { ...whole, delegate: pk(9) })).toEqual({
      available: 0n,
      staleReason: 'not_delegated',
    })
  })

  it('keeps what can still be bought when the account falls short', () => {
    expect(assess(offer, { ...whole, delegatedAmount: 1_200n })).toEqual({
      available: 1_200n,
      staleReason: 'delegation_short',
    })
    expect(assess(offer, { ...whole, amount: 700n })).toEqual({
      available: 700n,
      staleReason: 'balance_short',
    })
    expect(assess(offer, { ...whole, amount: 0n })).toEqual({
      available: 0n,
      staleReason: 'balance_short',
    })
  })
})

type Row = OpenOffer & {
  checkedAt: Date | null
  checkedSlot: bigint | null
  touchedSlot: bigint
  status: 'open' | 'filled' | 'cancelled'
  reading?: Reading
}

// The SQL of `offerBook` on a map: due by `checked_at`, never-read first; a
// reading lands only on an open offer with the same remaining, not touched later.
function memoryBook(rows: Row[]) {
  const book: OfferBook = {
    due: (before, limit) =>
      Promise.resolve(
        rows
          .filter((r) => r.status === 'open' && (r.checkedAt === null || r.checkedAt < before))
          .sort((a, b) => (a.checkedAt?.getTime() ?? -1) - (b.checkedAt?.getTime() ?? -1))
          .slice(0, limit)
          .map(({ offer, mint, seller, remaining }) => ({ offer, mint, seller, remaining })),
      ),
    record: (offer, reading) => {
      const row = rows.find((r) => r.offer === offer.offer)
      if (
        row === undefined ||
        row.status !== 'open' ||
        row.remaining !== offer.remaining ||
        row.touchedSlot > reading.checkedSlot ||
        (row.checkedSlot !== null && row.checkedSlot > reading.checkedSlot)
      ) {
        return Promise.resolve(false)
      }
      Object.assign(row, {
        checkedAt: reading.checkedAt,
        checkedSlot: reading.checkedSlot,
        reading,
      })
      return Promise.resolve(true)
    },
  }
  return book
}

function scriptedRpc(slot: number, accounts: Record<string, TokenAccountState | null>) {
  const calls: string[][] = []
  const rpc: StaleRpc = {
    tokenAccounts: (keys) => {
      calls.push([...keys])
      return Promise.resolve({ slot, accounts: keys.map((k) => accounts[k] ?? null) })
    },
  }
  return { rpc, calls }
}

const row = (n: number, overrides: Partial<Row> = {}): Row => ({
  offer: pk(20 + n),
  mint: MINT,
  seller: pk(40 + n),
  remaining: 3_000n,
  checkedAt: null,
  checkedSlot: null,
  touchedSlot: 100n,
  status: 'open',
  ...overrides,
})

const sellerAta = (r: Row) => ata(new PublicKey(r.seller), new PublicKey(r.mint)).toBase58()

describe('createStaleSweep', () => {
  it('reads the seller ATA of every due offer in one call and writes each verdict', async () => {
    const fresh = row(1)
    const revoked = row(2)
    const rows = [fresh, revoked]
    const { rpc, calls } = scriptedRpc(200, {
      [sellerAta(fresh)]: { ...whole, delegate: fresh.offer },
      [sellerAta(revoked)]: { ...whole, delegate: null },
    })
    const now = new Date('2026-09-29T12:00:00Z')
    const sweep = createStaleSweep({ book: memoryBook(rows), rpc, now: () => now })
    expect(await sweep()).toEqual({ due: 2, written: 2, discarded: 0 })
    expect(calls).toEqual([[sellerAta(fresh), sellerAta(revoked)]])
    expect(fresh.reading).toEqual({
      available: 3_000n,
      staleReason: null,
      checkedAt: now,
      checkedSlot: 200n,
    })
    expect(revoked.reading?.staleReason).toBe('not_delegated')
  })

  it('does not read again within the TTL, and does once it has passed', async () => {
    const offer = row(1)
    const { rpc, calls } = scriptedRpc(200, {
      [sellerAta(offer)]: { ...whole, delegate: offer.offer },
    })
    let clock = new Date('2026-09-29T12:00:00Z').getTime()
    const sweep = createStaleSweep({ book: memoryBook([offer]), rpc, now: () => new Date(clock) })
    await sweep()
    // The clock is what decides: witness that it moved, and by how much.
    clock += STALE_TTL_MS - 1
    expect(await sweep()).toEqual({ due: 0, written: 0, discarded: 0 })
    expect(calls).toHaveLength(1)
    clock += 2
    expect(await sweep()).toEqual({ due: 1, written: 1, discarded: 0 })
    expect(calls).toHaveLength(2)
    expect(offer.checkedAt).toEqual(new Date(clock))
  })

  it('discards a reading older than what the index knows', async () => {
    // Touched by a transfer at slot 300; the node answers from slot 250.
    const touched = row(1, { touchedSlot: 300n })
    const rows = [touched]
    const { rpc } = scriptedRpc(250, { [sellerAta(touched)]: { ...whole, delegate: null } })
    const sweep = createStaleSweep({ book: memoryBook(rows), rpc })
    expect(await sweep()).toEqual({ due: 1, written: 0, discarded: 1 })
    expect(touched.reading).toBeUndefined()
    expect(touched.checkedAt).toBeNull()
  })

  it('makes no call when nothing is due', async () => {
    const { rpc, calls } = scriptedRpc(200, {})
    const done = row(1, { status: 'filled' })
    const sweep = createStaleSweep({ book: memoryBook([done]), rpc })
    expect(await sweep()).toEqual({ due: 0, written: 0, discarded: 0 })
    expect(calls).toEqual([])
  })
})
