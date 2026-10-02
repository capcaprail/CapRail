import { type OfferQuoteAmounts, quoteOffer, validateOfferTerms } from '@caprail/chain'
import type { OfferView, Position } from '@caprail/shared'
import { amountField, fromBaseUnits, type Parsed } from '../../company/fields.ts'
import { type PaymentMint, pricePerUnitField } from '../money.ts'

// The seller's side: what may be offered, and the offer form.

/**
 * A token account has one delegate, so `create_offer` refuses while an offer of the
 * same account is open (`DelegationInUse`). The form says so instead of letting the
 * wallet sign a refusal.
 */
export function openOfferOf(mint: string, offers: readonly OfferView[]): OfferView | null {
  return offers.find((offer) => offer.mint === mint && offer.status === 'open') ?? null
}

export type OfferInput = { amount: string; price: string }
export type OfferValue = {
  amount: bigint
  pricePerUnit: bigint
  /** What a buyer of the whole offer would pay, and the fee out of it. */
  quote: OfferQuoteAmounts
}

export function parseOfferForm(
  input: OfferInput,
  position: Pick<Position, 'vested' | 'token'>,
  platform: PaymentMint & { feeBps: number },
): Parsed<OfferValue, keyof OfferInput> {
  const errors: Partial<Record<keyof OfferInput, string>> = {}
  const decimals = position.token.decimals
  const amount = amountField(input.amount, decimals)
  if ('error' in amount) errors.amount = amount.error
  // Vesting arrives with US3; until then `vested` is the whole holding. Offering more
  // is refused by `create_offer` (`OfferExceedsBalance`).
  else if (amount.value > BigInt(position.vested)) {
    errors.amount = `at most ${fromBaseUnits(position.vested, decimals)} — what you hold`
  }
  const price = pricePerUnitField(input.price, decimals, platform)
  if ('error' in price) errors.price = price.error

  if ('error' in amount || 'error' in price || errors.amount !== undefined) {
    return { ok: false, errors }
  }
  try {
    validateOfferTerms(amount.value, price.value)
  } catch {
    return { ok: false, errors: { price: 'the total for this amount does not fit a u64' } }
  }
  return {
    ok: true,
    value: {
      amount: amount.value,
      pricePerUnit: price.value,
      quote: quoteOffer(platform.feeBps, price.value, amount.value),
    },
  }
}

/** A random u64 — the seller picks the id (`create_offer` takes it), as with companies. */
export function randomOfferId(): bigint {
  const bytes = new Uint8Array(8)
  crypto.getRandomValues(bytes)
  return new DataView(bytes.buffer).getBigUint64(0, true)
}
