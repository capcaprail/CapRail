import type { OfferRecord } from '@caprail/shared'
import { describe, expect, it } from 'vitest'
import { STALE_TEXT } from '../../market/offer.ts'
import { bookCounts, filterBook, offerState } from './model.ts'

type Reading = Pick<
  OfferRecord,
  'status' | 'remaining' | 'available' | 'staleReason' | 'closedAt' | 'checkedAt'
>
const offer = (patch: Partial<Reading> = {}): Reading => ({
  status: 'open',
  remaining: '60',
  available: '60',
  staleReason: null,
  closedAt: null,
  checkedAt: null,
  ...patch,
})

describe('offerState', () => {
  it('is open while the seller backs the whole remainder, or before the first reading', () => {
    expect(offerState(offer())).toEqual({ kind: 'open' })
    expect(offerState(offer({ available: null }))).toEqual({ kind: 'open' })
  })

  it('is stale, with what can be taken and why, when the account gives less', () => {
    expect(
      offerState(
        offer({
          available: '25',
          staleReason: 'balance_short',
          checkedAt: '2026-10-03T10:00:00.000Z',
        }),
      ),
    ).toEqual({
      kind: 'stale',
      max: 25n,
      reason: STALE_TEXT.balance_short,
      checkedAt: '2026-10-03T10:00:00.000Z',
    })
  })

  it('is closed with its time once filled or cancelled, whatever the last reading said', () => {
    const at = '2026-10-03T11:00:00.000Z'
    expect(offerState(offer({ status: 'filled', remaining: '0', closedAt: at }))).toEqual({
      kind: 'filled',
      at,
    })
    expect(offerState(offer({ status: 'cancelled', available: null, closedAt: at }))).toEqual({
      kind: 'cancelled',
      at,
    })
  })
})

describe('filterBook', () => {
  it('keeps the book order and narrows by status', () => {
    const book = [
      { id: 'a', status: 'open' },
      { id: 'b', status: 'filled' },
      { id: 'c', status: 'open' },
      { id: 'd', status: 'cancelled' },
    ] as const
    expect(filterBook(book, 'all').map((o) => o.id)).toEqual(['a', 'b', 'c', 'd'])
    expect(filterBook(book, 'open').map((o) => o.id)).toEqual(['a', 'c'])
    expect(filterBook(book, 'filled').map((o) => o.id)).toEqual(['b'])
    expect(filterBook(book, 'cancelled').map((o) => o.id)).toEqual(['d'])
  })
})

describe('bookCounts', () => {
  it('tallies statuses, the shares on offer, and how much of them can be taken now', () => {
    expect(
      bookCounts([
        offer(),
        offer({ remaining: '40', available: '0', staleReason: 'not_delegated' }),
        offer({ remaining: '30', available: '10', staleReason: 'balance_short' }),
        offer({ status: 'filled', remaining: '0', available: null }),
        offer({ status: 'cancelled', remaining: '15', available: null }),
      ]),
    ).toEqual({
      offers: 5,
      open: 3,
      stale: 2,
      filled: 1,
      cancelled: 1,
      onOffer: 130n,
      takeableNow: 70n,
    })
    expect(bookCounts([]).takeableNow).toBe(0n)
  })
})
