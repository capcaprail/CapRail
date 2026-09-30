import { z } from 'zod'
import {
  companyIdSchema,
  type InvestorStatus,
  investorViewSchema,
  isoTimeSchema,
  type TransferPolicy,
  transferPolicySchema,
  u64StringSchema,
} from './company-api.ts'
import { walletAddressSchema } from './primitives.ts'

// The secondary market (US2) as the index stores it and the API will answer it.

// `OfferStatus` on chain. "In the ROFR window" is not a status — it is derived from
// `rofr_until`, as the program does.
export const OFFER_STATUSES = ['open', 'filled', 'cancelled'] as const
export type OfferStatus = (typeof OFFER_STATUSES)[number]

// Why an open offer cannot be taken for its whole `remaining` right now. Delegation
// is not escrow: the seller can revoke, spend or have the account frozen without
// our program seeing it, and `accept_offer` then refuses with `OfferStale` (or
// Token-2022 with its own code). The first reason that applies, in this order.
export const OFFER_STALE_REASONS = [
  // the seller's token account is gone
  'account_missing',
  'frozen',
  // the delegate is not this offer (revoked, or re-approved to someone else)
  'not_delegated',
  // delegated to this offer, but for less than `remaining`
  'delegation_short',
  // the account holds less than `remaining`
  'balance_short',
] as const
export type OfferStaleReason = (typeof OFFER_STALE_REASONS)[number]

// ── API read models (PLAN → API-контракти, US2) ───────────────────────────────────

// Admission the way the hook decides it (`caprail-hook` `execute`, check 2): a policy
// without accreditation admits anyone; otherwise the wallet needs a registry record
// that is `approved` and not yet expired — strictly, as the hook compares
// `expires_at > now`. Expiry is whole seconds on chain, so comparing milliseconds
// gives the same answer. The market's SQL mirror is `caprail_admits` (migration 0004);
// the chain has the last word at transfer time either way (FR-012).
export type AdmissionRecord = { status: InvestorStatus; expiresAt: string }

export const admissionSchema = z.object({
  admitted: z.boolean(),
  // The reason the hook would refuse a transfer to this wallet right now.
  reason: z.enum(['NotAccredited', 'AccreditationExpired']).nullable(),
})
export type Admission = z.infer<typeof admissionSchema>

export function admission(
  policy: Pick<TransferPolicy, 'requireAccreditation'>,
  record: AdmissionRecord | null,
  now: Date,
): Admission {
  if (!policy.requireAccreditation) return { admitted: true, reason: null }
  if (record === null || record.status !== 'approved') {
    return { admitted: false, reason: 'NotAccredited' }
  }
  if (Date.parse(record.expiresAt) <= now.getTime()) {
    return { admitted: false, reason: 'AccreditationExpired' }
  }
  return { admitted: true, reason: null }
}

// `PlatformConfig` as read from the chain. It has no update instruction, so this is
// the fee every trade on this deployment pays.
export const platformViewSchema = z.object({
  feeBps: z.number().int().min(0).max(10_000),
  paymentMint: z.string().min(1),
  feeTreasury: z.string().min(1),
})
export type PlatformView = z.infer<typeof platformViewSchema>

// What taking the whole `remaining` costs, computed with the program's formula, so
// both sides see the fee before they accept (FR-013). A partial take is the same
// formula on a smaller amount (`platformFee` in `packages/chain`).
export const offerQuoteSchema = z.object({
  amount: u64StringSchema,
  payment: u64StringSchema,
  fee: u64StringSchema,
  sellerReceives: u64StringSchema,
})
export type OfferQuote = z.infer<typeof offerQuoteSchema>

// The index row of an offer. `available`/`staleReason`/`checkedAt` are the worker's
// last reading of the seller's account (T039): `available < remaining` means only
// that much can be taken now, and `staleReason` says why.
export const offerRecordSchema = z.object({
  offer: z.string().min(1),
  mint: z.string().min(1),
  companyId: companyIdSchema,
  seller: walletAddressSchema,
  offerId: u64StringSchema,
  amount: u64StringSchema,
  remaining: u64StringSchema,
  pricePerUnit: u64StringSchema,
  paymentMint: z.string().min(1),
  rofrUntil: isoTimeSchema.nullable(),
  status: z.enum(OFFER_STATUSES),
  createdAt: isoTimeSchema,
  closedAt: isoTimeSchema.nullable(),
  available: u64StringSchema.nullable(),
  staleReason: z.enum(OFFER_STALE_REASONS).nullable(),
  checkedAt: isoTimeSchema.nullable(),
})
export type OfferRecord = z.infer<typeof offerRecordSchema>

// null when the offer is not open or the platform is not initialised on this
// deployment — no number is better than a fee the chain would not charge.
export const offerViewSchema = offerRecordSchema.extend({ quote: offerQuoteSchema.nullable() })
export type OfferView = z.infer<typeof offerViewSchema>

export const companyOffersQuerySchema = z.object({
  mint: z.string().min(1).optional(),
  status: z.enum(OFFER_STATUSES).optional(),
})
export type CompanyOffersQuery = z.infer<typeof companyOffersQuerySchema>

export const companyOffersSchema = z.object({
  platform: platformViewSchema.nullable(),
  offers: z.array(offerViewSchema),
})
export type CompanyOffers = z.infer<typeof companyOffersSchema>

// A viewer outside the company has no other way to name what is on sale.
export const offerTokenSchema = z.object({
  companyName: z.string(),
  name: z.string(),
  symbol: z.string(),
  decimals: z.number().int().min(0),
})

export const marketOfferRecordSchema = offerRecordSchema.extend({ token: offerTokenSchema })
export type MarketOfferRecord = z.infer<typeof marketOfferRecordSchema>

export const marketOfferSchema = offerViewSchema.extend({ token: offerTokenSchema })
export type MarketOffer = z.infer<typeof marketOfferSchema>

export const marketOffersQuerySchema = z.object({ mint: z.string().min(1).optional() })
export type MarketOffersQuery = z.infer<typeof marketOffersQuerySchema>

export const marketOffersSchema = z.object({
  platform: platformViewSchema.nullable(),
  offers: z.array(marketOfferSchema),
})
export type MarketOffers = z.infer<typeof marketOffersSchema>

// One line of the cabinet (FR-016): a mint the wallet holds or is registered for —
// an approved investor with nothing yet, or a holder whose record was revoked,
// still needs to see where they stand.
export const positionSchema = z.object({
  companyId: companyIdSchema,
  token: offerTokenSchema.extend({ mint: z.string().min(1) }),
  policy: transferPolicySchema,
  amount: u64StringSchema,
  // Vesting arrives with US3 (grants); until then everything held is vested.
  vested: u64StringSchema,
  unvested: u64StringSchema,
  registry: investorViewSchema
    .pick({ status: true, expiresAt: true, jurisdiction: true, investorType: true })
    .nullable(),
  admission: admissionSchema,
})
export type Position = z.infer<typeof positionSchema>

export type CabinetRecord = { positions: Position[]; offers: OfferRecord[] }

export const meSchema = z.object({
  wallet: walletAddressSchema,
  platform: platformViewSchema.nullable(),
  positions: z.array(positionSchema),
  // The wallet's own open offers; filled and cancelled ones are history, not the cabinet.
  offers: z.array(offerViewSchema),
})
export type Me = z.infer<typeof meSchema>
