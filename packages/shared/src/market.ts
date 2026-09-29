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
