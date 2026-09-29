import { IDL } from '@caprail/chain'
import { Keypair } from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import { decodeEvent } from './events.ts'
import { parseTransaction } from './parse.ts'
import {
  acceptOfferTx,
  eventDiscriminator,
  offerAcceptedData,
  offerCancelledData,
  offerCreatedData,
  offerInstructionTx,
  transferAllowedData,
} from './testing.ts'

const key = (n: number) => Keypair.fromSeed(new Uint8Array(32).fill(n)).publicKey.toBase58()

const OFFER = key(1)
const COMPANY = key(2)
const MINT = key(3)
const SELLER = key(4)
const BUYER = key(5)
const USDC = key(6)
const SELLER_ATA = key(7)
const BUYER_ATA = key(8)

// Values at the edges of their types: a u64 above 2^63 (a signed read would go
// negative) and a timestamp that is not a round number.
const BIG = 2n ** 64n - 3n
const T = 1_790_000_123

const created = {
  offer: OFFER,
  company: COMPANY,
  mint: MINT,
  seller: SELLER,
  offerId: BIG,
  amount: 3_000n,
  pricePerUnit: 1_500_000n,
  paymentMint: USDC,
  rofrUntil: 0,
  createdAt: T,
}

const accepted = {
  offer: OFFER,
  company: COMPANY,
  mint: MINT,
  seller: SELLER,
  buyer: BUYER,
  offerId: BIG,
  amount: 1_000n,
  pricePerUnit: 1_500_000n,
  payment: 1_500_000_000n,
  fee: 15_000_000n,
  paymentMint: USDC,
  remaining: 2_000n,
  acceptedAt: T + 60,
}

const cancelled = {
  offer: OFFER,
  mint: MINT,
  seller: SELLER,
  offerId: BIG,
  remaining: 2_000n,
  delegationRevoked: false,
  cancelledAt: T + 120,
}

describe('market events', () => {
  it('have the discriminators the IDL declares — the IDL and the Rust names agree', () => {
    for (const name of ['OfferCreated', 'OfferAccepted', 'OfferCancelled', 'TransferAllowed']) {
      const camel = name[0]?.toLowerCase() + name.slice(1)
      const declared = IDL.events.find((e) => e.name === camel)
      expect(declared, name).toBeDefined()
      expect([...eventDiscriminator(name)], name).toEqual(declared?.discriminator)
    }
  })

  it('decode every field from bytes laid out as events.rs declares them', () => {
    expect(decodeEvent(offerCreatedData(created))).toEqual({ kind: 'OfferCreated', ...created })
    expect(decodeEvent(offerAcceptedData(accepted))).toEqual({
      kind: 'OfferAccepted',
      ...accepted,
    })
    expect(decodeEvent(offerCancelledData(cancelled))).toEqual({
      kind: 'OfferCancelled',
      ...cancelled,
    })
  })

  it('keep a ROFR deadline and a revoked delegation as the chain wrote them', () => {
    const withWindow = decodeEvent(offerCreatedData({ ...created, rofrUntil: T + 86_400 }))
    expect(withWindow).toMatchObject({ rofrUntil: T + 86_400 })
    const revoked = decodeEvent(offerCancelledData({ ...cancelled, delegationRevoked: true }))
    expect(revoked).toMatchObject({ delegationRevoked: true })
  })

  // The layout decoder alone returns `acceptedAt: 0` for the first cut and ignores
  // the extra byte of the second.
  it('fail loudly on a payload that is not exactly the declared layout', () => {
    const full = Buffer.from(offerAcceptedData(accepted), 'base64')
    const short = full.subarray(0, full.length - 8).toString('base64')
    const long = Buffer.concat([full, Buffer.from([0])]).toString('base64')
    expect(() => decodeEvent(short)).toThrow('do not round-trip')
    expect(() => decodeEvent(long)).toThrow('do not round-trip')
  })
})

describe('parseTransaction on market transactions', () => {
  const tx = { signature: 'sig', slot: 500, blockTime: T }

  it('reads create_offer and cancel_offer as one event each', () => {
    const create = parseTransaction(
      offerInstructionTx(tx, 'CreateOffer', offerCreatedData(created)),
    )
    expect(create.events).toEqual([{ kind: 'OfferCreated', ...created, eventIndex: 0 }])
    const cancel = parseTransaction(
      offerInstructionTx(tx, 'CancelOffer', offerCancelledData(cancelled)),
    )
    expect(cancel.events).toEqual([{ kind: 'OfferCancelled', ...cancelled, eventIndex: 0 }])
  })

  it('reads accept_offer as the hook transfer first, then the trade', () => {
    const transfer = {
      company: COMPANY,
      mint: MINT,
      source: SELLER_ATA,
      destination: BUYER_ATA,
      sourceOwner: SELLER,
      destinationOwner: BUYER,
      amount: 1_000n,
      fromTreasury: false,
      policyVersion: 2,
    }
    const parsed = parseTransaction(
      acceptOfferTx(tx, transferAllowedData(transfer), offerAcceptedData(accepted)),
    )
    expect(parsed.rejection).toBeNull()
    expect(parsed.failure).toBeNull()
    expect(parsed.events).toEqual([
      { kind: 'TransferAllowed', ...transfer, eventIndex: 0 },
      { kind: 'OfferAccepted', ...accepted, eventIndex: 1 },
    ])
  })

  it('reads nothing from a failed accept — its events never happened', () => {
    const ok = acceptOfferTx(
      tx,
      transferAllowedData({
        company: COMPANY,
        mint: MINT,
        source: SELLER_ATA,
        destination: BUYER_ATA,
        sourceOwner: SELLER,
        destinationOwner: BUYER,
        amount: 1_000n,
        fromTreasury: false,
        policyVersion: 2,
      }),
      offerAcceptedData(accepted),
    )
    const parsed = parseTransaction({ ...ok, failed: true })
    expect(parsed.events).toEqual([])
  })
})
