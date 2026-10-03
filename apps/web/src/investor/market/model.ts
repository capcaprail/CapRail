import { type OfferQuoteAmounts, quoteOffer } from '@caprail/chain'
import type { OfferRecord } from '@caprail/shared'
import { amountField, fromBaseUnits, type Parsed } from '../../company/fields.ts'
import { takeable } from '../../market/offer.ts'

export type AcceptInput = { quantity: string }
export type AcceptValue = { amount: bigint; quote: OfferQuoteAmounts }

/**
 * The buyer's quantity → the amount `buildAcceptOffer` takes and the quote it will
 * carry. The quote is `quoteOffer` — the formula the API quoted the offer with and the
 * plan is built with — so the number on the form is the number the chain charges.
 */
export function parseAcceptForm(
  input: AcceptInput,
  offer: Pick<OfferRecord, 'remaining' | 'available' | 'staleReason' | 'pricePerUnit'>,
  tokenDecimals: number,
  feeBps: number,
): Parsed<AcceptValue, 'quantity'> {
  const parsed = amountField(input.quantity, tokenDecimals)
  if ('error' in parsed) return { ok: false, errors: { quantity: parsed.error } }
  const { max } = takeable(offer)
  if (parsed.value > max) {
    return {
      ok: false,
      errors: { quantity: `at most ${fromBaseUnits(max, tokenDecimals)} can be taken now` },
    }
  }
  return {
    ok: true,
    value: {
      amount: parsed.value,
      quote: quoteOffer(feeBps, BigInt(offer.pricePerUnit), parsed.value),
    },
  }
}
