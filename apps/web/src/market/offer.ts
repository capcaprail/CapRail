import type { OfferRecord, OfferStaleReason } from '@caprail/shared'

// What an open offer lets a buyer take right now. Delegation is not escrow: the
// worker's last reading of the seller's account (`available`, `staleReason`) may be
// below `remaining`, and `accept_offer` refuses more than the account can give
// (`OfferStale`). Such offers stay on the storefront and in the company's book with
// the reason named — the product names why something cannot happen rather than
// hiding it.

export const STALE_TEXT: Record<OfferStaleReason, string> = {
  account_missing: "the seller's token account is closed",
  frozen: "the seller's token account is frozen",
  not_delegated: 'the seller withdrew the delegation',
  delegation_short: 'the seller delegated less than offered',
  balance_short: 'the seller holds less than offered',
}

export type Takeable = {
  /** At most this much can be accepted now; 0 means not at all. */
  readonly max: bigint
  /** Why `max` is below `remaining`, or null when the whole remainder is there. */
  readonly reason: string | null
}

export function takeable(offer: Pick<OfferRecord, 'remaining' | 'available' | 'staleReason'>) {
  const remaining = BigInt(offer.remaining)
  // Not yet read by the worker: `create_offer` itself checked balance and delegation.
  const available = offer.available === null ? remaining : BigInt(offer.available)
  const max = available < remaining ? available : remaining
  const reason =
    max < remaining
      ? offer.staleReason === null
        ? 'the seller can deliver less than offered'
        : STALE_TEXT[offer.staleReason]
      : null
  return { max, reason } satisfies Takeable
}
