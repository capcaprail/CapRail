import { quoteOffer } from '@caprail/chain'
import type { OfferRecord } from '@caprail/shared'
import { describe, expect, it } from 'vitest'
import { parseAcceptForm, STALE_TEXT, takeable } from './model.ts'

type Terms = Pick<OfferRecord, 'remaining' | 'available' | 'staleReason' | 'pricePerUnit'>
const offer = (patch: Partial<Terms> = {}): Terms => ({
  remaining: '60',
  available: '60',
  staleReason: null,
  pricePerUnit: '1500000',
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

describe('parseAcceptForm', () => {
  it('quotes the whole remainder as the API does — the numbers the chain will charge', () => {
    // The API's `quote` for this offer at 100 bps: 60 × 1.5 dUSD.
    const parsed = parseAcceptForm({ quantity: '60' }, offer(), 0, 100)
    expect(parsed).toEqual({
      ok: true,
      value: {
        amount: 60n,
        quote: { amount: 60n, payment: 90_000_000n, fee: 900_000n, sellerReceives: 89_100_000n },
      },
    })
  })

  it('a part is the same formula on the smaller amount', () => {
    const parsed = parseAcceptForm({ quantity: '7' }, offer({ pricePerUnit: '199' }), 0, 50)
    expect(parsed.ok && parsed.value.quote).toEqual(quoteOffer(50, 199n, 7n))
  })

  it('refuses more than can be taken now, zero, and fractions of an indivisible share', () => {
    expect(parseAcceptForm({ quantity: '61' }, offer(), 0, 100)).toEqual({
      ok: false,
      errors: { quantity: 'at most 60 can be taken now' },
    })
    expect(
      parseAcceptForm(
        { quantity: '26' },
        offer({ available: '25', staleReason: 'frozen' }),
        0,
        100,
      ),
    ).toEqual({ ok: false, errors: { quantity: 'at most 25 can be taken now' } })
    expect(parseAcceptForm({ quantity: '0' }, offer(), 0, 100).ok).toBe(false)
    expect(parseAcceptForm({ quantity: '1.5' }, offer(), 0, 100).ok).toBe(false)
  })

  it('reads whole tokens for a token with decimals', () => {
    const parsed = parseAcceptForm(
      { quantity: '0.25' },
      offer({ remaining: '100', available: '100' }),
      2,
      0,
    )
    expect(parsed.ok && parsed.value.amount).toBe(25n)
  })
})
