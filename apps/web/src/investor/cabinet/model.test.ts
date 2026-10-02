import type { OfferView, Position } from '@caprail/shared'
import { describe, expect, it } from 'vitest'
import { openOfferOf, parseOfferForm, randomOfferId } from './model.ts'

const PLATFORM = {
  feeBps: 250,
  paymentMint: 'DemoUsdc1111111111111111111111111111111111111',
  paymentDecimals: 6,
  paymentSymbol: 'dUSD',
}
const position = (vested: string, decimals = 0): Pick<Position, 'vested' | 'token'> => ({
  vested,
  token: { mint: 'Mint1', companyName: 'Acme', name: 'Acme A', symbol: 'ACME', decimals },
})

describe('parseOfferForm', () => {
  it('turns quantity and share price into the builder terms and the buyer-side quote', () => {
    expect(parseOfferForm({ amount: '600', price: '0.25' }, position('1000'), PLATFORM)).toEqual({
      ok: true,
      value: {
        amount: 600n,
        pricePerUnit: 250_000n,
        quote: {
          amount: 600n,
          payment: 150_000_000n,
          fee: 3_750_000n,
          sellerReceives: 146_250_000n,
        },
      },
    })
  })

  it('refuses more than is held, and reports every field at once', () => {
    expect(parseOfferForm({ amount: '1001', price: '' }, position('1000'), PLATFORM)).toEqual({
      ok: false,
      errors: { amount: 'at most 1,000 — what you hold', price: 'required' },
    })
  })

  it('refuses terms whose total does not fit a u64, as validate_terms does', () => {
    const huge = position('18446744073709551615')
    expect(parseOfferForm({ amount: '18446744073709551615', price: '1' }, huge, PLATFORM)).toEqual({
      ok: false,
      errors: { price: 'the total for this amount does not fit a u64' },
    })
  })
})

describe('openOfferOf', () => {
  it('finds the open offer of the mint — one per token account', () => {
    const offers = [
      { mint: 'Mint1', status: 'open' },
      { mint: 'Mint2', status: 'open' },
    ] as OfferView[]
    expect(openOfferOf('Mint2', offers)).toBe(offers[1])
    expect(openOfferOf('Mint3', offers)).toBeNull()
  })
})

describe('randomOfferId', () => {
  it('is a u64 and does not repeat', () => {
    const ids = Array.from({ length: 64 }, randomOfferId)
    expect(ids.every((id) => id >= 0n && id <= 0xffff_ffff_ffff_ffffn)).toBe(true)
    expect(new Set(ids).size).toBe(64)
  })
})
