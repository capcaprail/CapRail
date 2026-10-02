import { quoteOffer } from '@caprail/chain'
import type { OfferAccepted } from '@caprail/indexer'
import { describe, expect, it } from 'vitest'
import { type Trade, tradeMatchesQuote } from './us2.ts'

const quote = quoteOffer(100, 1_250_000n, 150n)
const event = {
  kind: 'OfferAccepted',
  amount: quote.amount,
  payment: quote.payment,
  fee: quote.fee,
} as OfferAccepted
const trade: Trade = {
  quote,
  event,
  deltas: {
    buyerPayment: -quote.payment,
    sellerPayment: quote.sellerReceives,
    feeTreasury: quote.fee,
    sellerShares: -quote.amount,
    buyerShares: quote.amount,
  },
  computeUnits: 1,
}

describe('tradeMatchesQuote', () => {
  it('holds when the event and all four balances moved by exactly the quote', () => {
    expect(tradeMatchesQuote(trade)).toBe(true)
  })

  it('fails on a fee one unit off, in the event or in the fee account', () => {
    expect(tradeMatchesQuote({ ...trade, event: { ...event, fee: quote.fee + 1n } })).toBe(false)
    expect(
      tradeMatchesQuote({ ...trade, deltas: { ...trade.deltas, feeTreasury: quote.fee - 1n } }),
    ).toBe(false)
  })

  it('fails when only one side of the exchange moved', () => {
    expect(tradeMatchesQuote({ ...trade, deltas: { ...trade.deltas, buyerShares: 0n } })).toBe(
      false,
    )
    expect(tradeMatchesQuote({ ...trade, deltas: { ...trade.deltas, sellerPayment: 0n } })).toBe(
      false,
    )
  })
})
