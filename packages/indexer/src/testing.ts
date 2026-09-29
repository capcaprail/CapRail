// Test support: market transactions as the chain would log them. There are no real
// US2 fixtures yet (the localnet demo of the market is T042), so the `Program data:`
// payloads are Borsh written by hand in the field order of
// `programs/caprail/src/events.rs` — not with the IDL's coder, which would only
// check the decoder against itself.
import { createHash } from 'node:crypto'
import { HOOK_PROGRAM_ID, PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@caprail/chain'
import { PublicKey } from '@solana/web3.js'
import type { ProgramTransaction } from './index.ts'

// Anchor: the first 8 bytes of sha256("event:<Name>").
export function eventDiscriminator(name: string): Buffer {
  return createHash('sha256').update(`event:${name}`).digest().subarray(0, 8)
}

class Borsh {
  private readonly parts: Buffer[] = []

  pubkey(value: string): this {
    this.parts.push(new PublicKey(value).toBuffer())
    return this
  }

  u64(value: bigint): this {
    const b = Buffer.alloc(8)
    b.writeBigUInt64LE(value)
    this.parts.push(b)
    return this
  }

  i64(value: number): this {
    const b = Buffer.alloc(8)
    b.writeBigInt64LE(BigInt(value))
    this.parts.push(b)
    return this
  }

  u32(value: number): this {
    const b = Buffer.alloc(4)
    b.writeUInt32LE(value)
    this.parts.push(b)
    return this
  }

  bool(value: boolean): this {
    this.parts.push(Buffer.from([value ? 1 : 0]))
    return this
  }

  event(name: string): string {
    return Buffer.concat([eventDiscriminator(name), ...this.parts]).toString('base64')
  }
}

export type OfferCreatedFields = {
  offer: string
  company: string
  mint: string
  seller: string
  offerId: bigint
  amount: bigint
  pricePerUnit: bigint
  paymentMint: string
  rofrUntil: number
  createdAt: number
}

export function offerCreatedData(e: OfferCreatedFields): string {
  return new Borsh()
    .pubkey(e.offer)
    .pubkey(e.company)
    .pubkey(e.mint)
    .pubkey(e.seller)
    .u64(e.offerId)
    .u64(e.amount)
    .u64(e.pricePerUnit)
    .pubkey(e.paymentMint)
    .i64(e.rofrUntil)
    .i64(e.createdAt)
    .event('OfferCreated')
}

export type OfferAcceptedFields = {
  offer: string
  company: string
  mint: string
  seller: string
  buyer: string
  offerId: bigint
  amount: bigint
  pricePerUnit: bigint
  payment: bigint
  fee: bigint
  paymentMint: string
  remaining: bigint
  acceptedAt: number
}

export function offerAcceptedData(e: OfferAcceptedFields): string {
  return new Borsh()
    .pubkey(e.offer)
    .pubkey(e.company)
    .pubkey(e.mint)
    .pubkey(e.seller)
    .pubkey(e.buyer)
    .u64(e.offerId)
    .u64(e.amount)
    .u64(e.pricePerUnit)
    .u64(e.payment)
    .u64(e.fee)
    .pubkey(e.paymentMint)
    .u64(e.remaining)
    .i64(e.acceptedAt)
    .event('OfferAccepted')
}

export type OfferCancelledFields = {
  offer: string
  mint: string
  seller: string
  offerId: bigint
  remaining: bigint
  delegationRevoked: boolean
  cancelledAt: number
}

export function offerCancelledData(e: OfferCancelledFields): string {
  return new Borsh()
    .pubkey(e.offer)
    .pubkey(e.mint)
    .pubkey(e.seller)
    .u64(e.offerId)
    .u64(e.remaining)
    .bool(e.delegationRevoked)
    .i64(e.cancelledAt)
    .event('OfferCancelled')
}

export type TransferAllowedFields = {
  company: string
  mint: string
  source: string
  destination: string
  sourceOwner: string
  destinationOwner: string
  amount: bigint
  fromTreasury: boolean
  policyVersion: number
}

export function transferAllowedData(e: TransferAllowedFields): string {
  return new Borsh()
    .pubkey(e.company)
    .pubkey(e.mint)
    .pubkey(e.source)
    .pubkey(e.destination)
    .pubkey(e.sourceOwner)
    .pubkey(e.destinationOwner)
    .u64(e.amount)
    .bool(e.fromTreasury)
    .u32(e.policyVersion)
    .event('TransferAllowed')
}

const CAPRAIL = PROGRAM_ID.toBase58()
const HOOK = HOOK_PROGRAM_ID.toBase58()
const TOKEN_2022 = TOKEN_2022_PROGRAM_ID.toBase58()

export type MarketTransaction = {
  signature: string
  slot: number
  blockTime: number
}

// `create_offer` / `cancel_offer`: one `caprail` frame and its event.
export function offerInstructionTx(
  tx: MarketTransaction,
  instruction: 'CreateOffer' | 'CancelOffer',
  event: string,
): ProgramTransaction {
  return {
    ...tx,
    failed: false,
    logs: [
      `Program ${CAPRAIL} invoke [1]`,
      `Program log: Instruction: ${instruction}`,
      `Program data: ${event}`,
      `Program ${CAPRAIL} consumed 30000 of 200000 compute units`,
      `Program ${CAPRAIL} success`,
    ],
    accountKeys: [],
    instructions: [],
  }
}

// `accept_offer` as it logs: the share transfer through Token-2022, where the hook
// emits `TransferAllowed`, then the two stablecoin transfers, then `OfferAccepted`.
export function acceptOfferTx(
  tx: MarketTransaction,
  transferAllowed: string,
  offerAccepted: string,
): ProgramTransaction {
  return {
    ...tx,
    failed: false,
    logs: [
      `Program ${CAPRAIL} invoke [1]`,
      'Program log: Instruction: AcceptOffer',
      `Program ${TOKEN_2022} invoke [2]`,
      'Program log: Instruction: TransferChecked',
      `Program ${HOOK} invoke [3]`,
      'Program log: Instruction: Execute',
      `Program data: ${transferAllowed}`,
      `Program ${HOOK} success`,
      `Program ${TOKEN_2022} success`,
      `Program ${TOKEN_2022} invoke [2]`,
      'Program log: Instruction: TransferChecked',
      `Program ${TOKEN_2022} success`,
      `Program ${TOKEN_2022} invoke [2]`,
      'Program log: Instruction: TransferChecked',
      `Program ${TOKEN_2022} success`,
      `Program data: ${offerAccepted}`,
      `Program ${CAPRAIL} consumed 160000 of 220000 compute units`,
      `Program ${CAPRAIL} success`,
    ],
    accountKeys: [],
    instructions: [],
  }
}
