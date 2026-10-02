import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ata, offerPda, platformFee } from '@caprail/chain'
import { PublicKey } from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import type { ProgramTransaction } from './index.ts'
import { type IndexedEvent, parseTransaction } from './parse.ts'

// The market as the ledger wrote it: `pnpm demo:us2 -- --dump fixtures/market` on
// localnet — one run, its US1 part included, at the platform fee of 100 bps. The
// hand-encoded events of `market.test.ts` cover the edges of the types; these cover
// what the program actually emits, in the order it emits it.
const DIR = join(import.meta.dirname, '..', '..', '..', 'fixtures', 'market')
const FEE_BPS = 100

type Fixture = ProgramTransaction & { kind: string }

const fixtures = new Map(
  readdirSync(DIR)
    .filter((name) => name.endsWith('.json'))
    .map((name) => {
      const fixture = JSON.parse(readFileSync(join(DIR, name), 'utf8')) as Fixture
      return [fixture.kind, fixture] as const
    }),
)

function fixture(kind: string): Fixture {
  const found = fixtures.get(kind)
  if (found === undefined) throw new Error(`no fixture ${kind}`)
  return found
}

function events(kind: string): IndexedEvent[] {
  const parsed = parseTransaction(fixture(kind))
  expect(parsed.failed, kind).toBe(false)
  expect(parsed.rejection, kind).toBeNull()
  expect(parsed.failure, kind).toBeNull()
  return parsed.events
}

function one<K extends IndexedEvent['kind']>(kind: string, eventKind: K) {
  const found = events(kind).filter((e) => e.kind === eventKind)
  expect(found, `${kind}: ${eventKind}`).toHaveLength(1)
  return found[0] as Extract<IndexedEvent, { kind: K }>
}

const created = one('create-offer', 'OfferCreated')

describe('market transactions from the ledger', () => {
  it('create_offer: the offer address is the PDA of (mint, seller, id)', () => {
    expect(created.offer).toBe(
      offerPda(
        new PublicKey(created.mint),
        new PublicKey(created.seller),
        created.offerId,
      ).toBase58(),
    )
    expect(created.rofrUntil).toBe(0)
    expect(created.amount).toBe(600n)
    expect(created.pricePerUnit).toBe(1_250_000n)
  })

  it('accept_offer: the share moves through the hook first, the trade is the last event', () => {
    const all = events('accept-offer-partial')
    expect(all.map((e) => [e.kind, e.eventIndex])).toEqual([
      ['TransferAllowed', 0],
      ['OfferAccepted', 1],
    ])
    const [moved, accepted] = all
    if (moved?.kind !== 'TransferAllowed' || accepted?.kind !== 'OfferAccepted') throw new Error()
    // The hook sees the seller as the sender — the owner of the account, not the
    // offer PDA that signed as its delegate.
    expect(moved.sourceOwner).toBe(created.seller)
    expect(moved.destinationOwner).toBe(accepted.buyer)
    expect(moved.amount).toBe(accepted.amount)
    expect(accepted.offer).toBe(created.offer)
    expect(accepted.payment).toBe(accepted.amount * accepted.pricePerUnit)
    // FR-013: the fee in the event is the formula's, on this payment.
    expect(accepted.fee).toBe(platformFee(FEE_BPS, accepted.payment))
    expect(accepted.remaining).toBe(created.amount - accepted.amount)
  })

  it('a filled offer reports remaining 0', () => {
    const filled = one('accept-offer-filled', 'OfferAccepted')
    expect(filled.remaining).toBe(0n)
    expect(filled.fee).toBe(platformFee(FEE_BPS, filled.payment))
  })

  it('cancel_offer: what was left, and that the delegation was this offer’s to revoke', () => {
    const cancelled = one('cancel-offer', 'OfferCancelled')
    expect(cancelled.offer).toBe(created.offer)
    expect(cancelled.remaining).toBe(450n)
    expect(cancelled.delegationRevoked).toBe(true)
  })

  it('a refused accept is a hook refusal of the share transfer; the signer is the offer', () => {
    const parsed = parseTransaction(fixture('accept-offer-refused-not-accredited'))
    expect(parsed.failed).toBe(true)
    expect(parsed.events).toEqual([])
    expect(parsed.rejection?.reason).toBe('NotAccredited')
    const transfer = parsed.rejection?.transfer
    expect(transfer?.mint).toBe(created.mint)
    expect(transfer?.source).toBe(
      ata(new PublicKey(created.seller), new PublicKey(created.mint)).toBase58(),
    )
    // The authority is the delegate, not a party: the worker resolves the owner.
    expect(transfer?.authority).toBe(created.offer)
    expect(transfer?.amount).toBe(50n)
  })
})
