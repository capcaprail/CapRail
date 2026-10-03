import { describe, expect, it } from 'vitest'
import { type AttemptMatch, pairTrades, type TradeMatch } from './reader.ts'

// The journal pairs each trade with its share transfer in code; what the worker writes
// for one `accept_offer` is the hook's `TransferAllowed` followed by `OfferAccepted`.

const SELLER = 'Seller1111111111111111111111111111111111111'
const BUYER = 'Buyer11111111111111111111111111111111111111'

const attempt = (id: number, eventIndex: number, patch: Partial<AttemptMatch> = {}) =>
  ({
    id: BigInt(id),
    txSignature: 'sig',
    eventIndex,
    mint: 'mint',
    sourceOwner: SELLER,
    destOwner: BUYER,
    amount: 25n,
    outcome: 'allowed',
    ...patch,
  }) satisfies AttemptMatch

const trade = (eventIndex: number, patch: Partial<TradeMatch> = {}) =>
  ({
    txSignature: 'sig',
    eventIndex,
    mint: 'mint',
    seller: SELLER,
    buyer: BUYER,
    amount: 25n,
    ...patch,
  }) satisfies TradeMatch

describe('pairTrades', () => {
  it('pairs a trade with the transfer the hook journaled just before it', () => {
    const paired = pairTrades([attempt(7, 0)], [trade(1)])
    expect([...paired.keys()]).toEqual([7n])
    expect(paired.get(7n)?.eventIndex).toBe(1)
  })

  it('pairs two accepts of one transaction each with its own transfer', () => {
    const paired = pairTrades([attempt(1, 0), attempt(2, 2)], [trade(1), trade(3)])
    expect(paired.get(1n)?.eventIndex).toBe(1)
    expect(paired.get(2n)?.eventIndex).toBe(3)
  })

  it('leaves alone what is not the trade: refusals, other parties, mints, amounts, transactions', () => {
    const others = [
      attempt(1, 0, { outcome: 'rejected' }),
      attempt(2, 0, { mint: 'other' }),
      attempt(3, 0, { sourceOwner: BUYER, destOwner: SELLER }),
      attempt(4, 0, { amount: 24n }),
      attempt(5, 0, { txSignature: 'another' }),
      // after the trade's event: a later transfer of the same transaction
      attempt(6, 2),
    ]
    expect(pairTrades(others, [trade(1)]).size).toBe(0)
  })

  it('leaves a plain transfer a plain transfer', () => {
    expect(pairTrades([attempt(1, 0)], []).size).toBe(0)
  })
})
