// The Anchor events the index reads: six of US1, three of the market (US2). Shapes follow
// `programs/caprail/src/events.rs`; every field the worker writes is here, so it
// never has to look at the transaction's accounts.
import { BorshCoder } from '@anchor-lang/core'
import { IDL, type InvestorStatus } from '@caprail/chain'

export type TransferPolicy = {
  requireAccreditation: boolean
  requireRofr: boolean
  rofrWindowSecs: number
}

export type CompanyCreated = {
  kind: 'CompanyCreated'
  company: string
  companyId: bigint
  admin: string
  complianceOfficer: string
  name: string
}

export type TokenCreated = {
  kind: 'TokenCreated'
  company: string
  mint: string
  treasury: string
  name: string
  symbol: string
  decimals: number
  totalSupply: bigint
  policy: TransferPolicy
  policyVersion: number
}

export type PolicySet = {
  kind: 'PolicySet'
  company: string
  mint: string
  policy: TransferPolicy
  policyVersion: number
  // unix seconds, the program's clock
  setAt: number
}

export type RolesSet = {
  kind: 'RolesSet'
  company: string
  admin: string
  complianceOfficer: string
  setAt: number
}

export type InvestorStatusSet = {
  kind: 'InvestorStatusSet'
  company: string
  mint: string
  wallet: string
  status: InvestorStatus
  expiresAt: number
  // ISO-2 or null where the chain holds [0, 0]
  jurisdiction: string | null
  investorType: number
  updatedAt: number
  updatedBy: string
}

export type TransferAllowed = {
  kind: 'TransferAllowed'
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

// Prices and payments are in minimal units of `paymentMint`; `pricePerUnit` is per
// minimal unit of the share token, so a payment is `amount * pricePerUnit` exactly.
export type OfferCreated = {
  kind: 'OfferCreated'
  offer: string
  company: string
  mint: string
  seller: string
  offerId: bigint
  amount: bigint
  pricePerUnit: bigint
  paymentMint: string
  // unix seconds; 0 — no ROFR window
  rofrUntil: number
  createdAt: number
}

export type OfferAccepted = {
  kind: 'OfferAccepted'
  offer: string
  company: string
  mint: string
  seller: string
  buyer: string
  offerId: bigint
  amount: bigint
  pricePerUnit: bigint
  // the whole payment; the seller received `payment - fee`
  payment: bigint
  fee: bigint
  paymentMint: string
  // after this trade; 0 — the offer is filled
  remaining: bigint
  acceptedAt: number
}

// No `company`: the mint places it.
export type OfferCancelled = {
  kind: 'OfferCancelled'
  offer: string
  mint: string
  seller: string
  offerId: bigint
  remaining: bigint
  // false — the delegation was no longer this offer's, nothing to revoke
  delegationRevoked: boolean
  cancelledAt: number
}

export type IndexEvent =
  | CompanyCreated
  | TokenCreated
  | PolicySet
  | RolesSet
  | InvestorStatusSet
  | TransferAllowed
  | OfferCreated
  | OfferAccepted
  | OfferCancelled

export type IndexEventKind = IndexEvent['kind']

// Anchor hands decoded data back untyped. Each reader checks the one shape it
// expects and throws otherwise: a mismatch means the vendored IDL and the program
// disagree, which is a build error, not a row to skip.
type Fields = Record<string, unknown>

function fields(value: unknown, where: string): Fields {
  if (typeof value !== 'object' || value === null) throw new Error(`${where}: not a struct`)
  return value as Fields
}

function pubkey(data: Fields, key: string): string {
  const value = data[key]
  if (typeof value === 'object' && value !== null && 'toBase58' in value) {
    return (value as { toBase58: () => string }).toBase58()
  }
  throw new Error(`event field ${key}: not a pubkey`)
}

// u64 / i64 arrive as BN; the index keeps u64 as bigint and i64 timestamps as number.
function big(data: Fields, key: string): bigint {
  const value = data[key]
  if (typeof value === 'object' && value !== null && 'toString' in value) {
    return BigInt((value as { toString: (radix?: number) => string }).toString(10))
  }
  throw new Error(`event field ${key}: not a BN`)
}

function unix(data: Fields, key: string): number {
  const value = big(data, key)
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new Error(`event field ${key}: timestamp out of range`)
  }
  return Number(value)
}

function num(data: Fields, key: string): number {
  const value = data[key]
  if (typeof value !== 'number') throw new Error(`event field ${key}: not a number`)
  return value
}

function bool(data: Fields, key: string): boolean {
  const value = data[key]
  if (typeof value !== 'boolean') throw new Error(`event field ${key}: not a bool`)
  return value
}

function str(data: Fields, key: string): string {
  const value = data[key]
  if (typeof value !== 'string') throw new Error(`event field ${key}: not a string`)
  return value
}

function policy(data: Fields, key: string): TransferPolicy {
  const value = fields(data[key], `event field ${key}`)
  return {
    requireAccreditation: bool(value, 'requireAccreditation'),
    requireRofr: bool(value, 'requireRofr'),
    rofrWindowSecs: num(value, 'rofrWindowSecs'),
  }
}

// A Rust enum decodes as `{ approved: {} }`; the variant name is the key.
const STATUS_VARIANTS: Record<string, InvestorStatus> = {
  none: 'none',
  approved: 'approved',
  revoked: 'revoked',
}

function status(data: Fields, key: string): InvestorStatus {
  const value = fields(data[key], `event field ${key}`)
  const variant = Object.keys(value)[0]
  const mapped = variant === undefined ? undefined : STATUS_VARIANTS[variant]
  if (mapped === undefined) throw new Error(`event field ${key}: unknown status ${variant}`)
  return mapped
}

// `[u8; 2]`: two ASCII uppercase letters, or [0, 0] for "not set" (the program
// accepts nothing else — `InvalidJurisdiction`).
function jurisdiction(data: Fields, key: string): string | null {
  const value = data[key]
  if (!Array.isArray(value) || value.length !== 2)
    throw new Error(`event field ${key}: not [u8; 2]`)
  if (value[0] === 0 && value[1] === 0) return null
  return String.fromCharCode(...(value as number[]))
}

// IDL event names are camelCase; the index keeps the Rust names.
const READERS: Record<string, (data: Fields) => IndexEvent> = {
  companyCreated: (d) => ({
    kind: 'CompanyCreated',
    company: pubkey(d, 'company'),
    companyId: big(d, 'companyId'),
    admin: pubkey(d, 'admin'),
    complianceOfficer: pubkey(d, 'complianceOfficer'),
    name: str(d, 'name'),
  }),
  tokenCreated: (d) => ({
    kind: 'TokenCreated',
    company: pubkey(d, 'company'),
    mint: pubkey(d, 'mint'),
    treasury: pubkey(d, 'treasury'),
    name: str(d, 'name'),
    symbol: str(d, 'symbol'),
    decimals: num(d, 'decimals'),
    totalSupply: big(d, 'totalSupply'),
    policy: policy(d, 'policy'),
    policyVersion: num(d, 'policyVersion'),
  }),
  policySet: (d) => ({
    kind: 'PolicySet',
    company: pubkey(d, 'company'),
    mint: pubkey(d, 'mint'),
    policy: policy(d, 'policy'),
    policyVersion: num(d, 'policyVersion'),
    setAt: unix(d, 'setAt'),
  }),
  rolesSet: (d) => ({
    kind: 'RolesSet',
    company: pubkey(d, 'company'),
    admin: pubkey(d, 'admin'),
    complianceOfficer: pubkey(d, 'complianceOfficer'),
    setAt: unix(d, 'setAt'),
  }),
  investorStatusSet: (d) => ({
    kind: 'InvestorStatusSet',
    company: pubkey(d, 'company'),
    mint: pubkey(d, 'mint'),
    wallet: pubkey(d, 'wallet'),
    status: status(d, 'status'),
    expiresAt: unix(d, 'expiresAt'),
    jurisdiction: jurisdiction(d, 'jurisdiction'),
    investorType: num(d, 'investorType'),
    updatedAt: unix(d, 'updatedAt'),
    updatedBy: pubkey(d, 'updatedBy'),
  }),
  transferAllowed: (d) => ({
    kind: 'TransferAllowed',
    company: pubkey(d, 'company'),
    mint: pubkey(d, 'mint'),
    source: pubkey(d, 'source'),
    destination: pubkey(d, 'destination'),
    sourceOwner: pubkey(d, 'sourceOwner'),
    destinationOwner: pubkey(d, 'destinationOwner'),
    amount: big(d, 'amount'),
    fromTreasury: bool(d, 'fromTreasury'),
    policyVersion: num(d, 'policyVersion'),
  }),
  offerCreated: (d) => ({
    kind: 'OfferCreated',
    offer: pubkey(d, 'offer'),
    company: pubkey(d, 'company'),
    mint: pubkey(d, 'mint'),
    seller: pubkey(d, 'seller'),
    offerId: big(d, 'offerId'),
    amount: big(d, 'amount'),
    pricePerUnit: big(d, 'pricePerUnit'),
    paymentMint: pubkey(d, 'paymentMint'),
    rofrUntil: unix(d, 'rofrUntil'),
    createdAt: unix(d, 'createdAt'),
  }),
  offerAccepted: (d) => ({
    kind: 'OfferAccepted',
    offer: pubkey(d, 'offer'),
    company: pubkey(d, 'company'),
    mint: pubkey(d, 'mint'),
    seller: pubkey(d, 'seller'),
    buyer: pubkey(d, 'buyer'),
    offerId: big(d, 'offerId'),
    amount: big(d, 'amount'),
    pricePerUnit: big(d, 'pricePerUnit'),
    payment: big(d, 'payment'),
    fee: big(d, 'fee'),
    paymentMint: pubkey(d, 'paymentMint'),
    remaining: big(d, 'remaining'),
    acceptedAt: unix(d, 'acceptedAt'),
  }),
  offerCancelled: (d) => ({
    kind: 'OfferCancelled',
    offer: pubkey(d, 'offer'),
    mint: pubkey(d, 'mint'),
    seller: pubkey(d, 'seller'),
    offerId: big(d, 'offerId'),
    remaining: big(d, 'remaining'),
    delegationRevoked: bool(d, 'delegationRevoked'),
    cancelledAt: unix(d, 'cancelledAt'),
  }),
}

export const EVENT_NAMES = Object.keys(READERS)

// Every event is declared by `caprail` — the hook emits `TransferAllowed` with
// the type it imports from there, and an event's discriminator is its name, not
// the program — so one coder decodes a `Program data:` line from either program.
const coder = new BorshCoder(IDL)

const DISCRIMINATOR_LENGTH = 8

// null: not one of ours (or not an event at all). Unknown discriminators are how
// another program's `Program data:` in the same transaction looks — not an error.
//
// The layout decoder reads zeros past the end of a short payload and ignores bytes
// left over, so a program whose event gained or lost a field against the vendored
// IDL would still decode — into plausible numbers. Encoding the result back and
// comparing it with the payload is what turns that drift into an error.
export function decodeEvent(base64: string): IndexEvent | null {
  const decoded = coder.events.decode(base64)
  if (decoded === null) return null
  const read = READERS[decoded.name]
  if (read === undefined) return null
  const body = Buffer.from(base64, 'base64').subarray(DISCRIMINATOR_LENGTH)
  if (!coder.types.encode(decoded.name, decoded.data).equals(body)) {
    throw new Error(
      `event ${decoded.name}: ${body.length} bytes do not round-trip through the IDL — program and IDL disagree`,
    )
  }
  return read(fields(decoded.data, `event ${decoded.name}`))
}
