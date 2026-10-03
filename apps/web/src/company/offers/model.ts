import type { OfferRecord } from '@caprail/shared'
import { takeable } from '../../market/offer.ts'

// The company's book, the pure parts: where each offer stands and the tallies of a
// mint's offers. The book is read-only for the company until ROFR (M4): it watches
// what its holders put up, at what price, and whether it can still be taken.

type Reading = Pick<
  OfferRecord,
  'status' | 'remaining' | 'available' | 'staleReason' | 'closedAt' | 'checkedAt'
>

export type OfferState =
  | { kind: 'open' }
  // Open, but the seller's account gives less than `remaining` — only `max` can be
  // taken now, and `reason` says why (T039's reading of the account).
  | { kind: 'stale'; max: bigint; reason: string; checkedAt: string | null }
  | { kind: 'filled'; at: string | null }
  | { kind: 'cancelled'; at: string | null }

export function offerState(offer: Reading): OfferState {
  if (offer.status === 'filled') return { kind: 'filled', at: offer.closedAt }
  if (offer.status === 'cancelled') return { kind: 'cancelled', at: offer.closedAt }
  const { max, reason } = takeable(offer)
  return reason === null
    ? { kind: 'open' }
    : { kind: 'stale', max, reason, checkedAt: offer.checkedAt }
}

export type BookFilter = 'all' | 'open' | 'filled' | 'cancelled'

export const BOOK_FILTERS: ReadonlyArray<{ value: BookFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'open', label: 'Open' },
  { value: 'filled', label: 'Filled' },
  { value: 'cancelled', label: 'Cancelled' },
]

export function filterBook<T extends Pick<OfferRecord, 'status'>>(
  offers: readonly T[],
  filter: BookFilter,
): T[] {
  return filter === 'all' ? [...offers] : offers.filter((offer) => offer.status === filter)
}

export type BookCounts = {
  offers: number
  open: number
  stale: number
  filled: number
  cancelled: number
  // Shares still on offer, and how much of that can actually be taken now.
  onOffer: bigint
  takeableNow: bigint
}

export function bookCounts(offers: readonly Reading[]): BookCounts {
  const counts: BookCounts = {
    offers: offers.length,
    open: 0,
    stale: 0,
    filled: 0,
    cancelled: 0,
    onOffer: 0n,
    takeableNow: 0n,
  }
  for (const offer of offers) {
    const state = offerState(offer)
    switch (state.kind) {
      case 'filled':
        counts.filled += 1
        break
      case 'cancelled':
        counts.cancelled += 1
        break
      default: {
        counts.open += 1
        const remaining = BigInt(offer.remaining)
        counts.onOffer += remaining
        if (state.kind === 'stale') {
          counts.stale += 1
          counts.takeableNow += state.max
        } else {
          counts.takeableNow += remaining
        }
      }
    }
  }
  return counts
}
