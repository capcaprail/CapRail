import type { OfferRecord } from '@caprail/shared'
import { describe, expect, it } from 'vitest'
import { STALE_TEXT, takeable } from './offer.ts'

type Reading = Pick<OfferRecord, 'remaining' | 'available' | 'staleReason'>
const offer = (patch: Partial<Reading> = {}): Reading => ({
  remaining: '60',
  available: '60',
  staleReason: null,
  ...patch,
})

describe('takeable', () => {
  it('is the whole remainder when the worker found it all, or has not looked yet', () => {
    expect(takeable(offer())).toEqual({ max: 60n, reason: null })
    expect(takeable(offer({ available: null }))).toEqual({ max: 60n, reason: null })
  })

  it('is what the seller can deliver, with the reason, when that is less', () => {
    expect(takeable(offer({ available: '25', staleReason: 'balance_short' }))).toEqual({
      max: 25n,
      reason: STALE_TEXT.balance_short,
    })
    expect(takeable(offer({ available: '0', staleReason: 'not_delegated' }))).toEqual({
      max: 0n,
      reason: 'the seller withdrew the delegation',
    })
  })
})
