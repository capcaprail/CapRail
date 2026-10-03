import type { PlatformView } from '@caprail/shared'
import { fromBaseUnits, toBaseUnits } from '../company/fields.ts'
import { short } from '../format.ts'

// Amounts in the payment mint. On chain a price is per minimal unit of the token in
// minimal units of the payment mint (`Offer.price_per_unit`); people think per share.
// The conversion is exact or refused — a price the form would round is a price the
// seller did not set.

export type PaymentMint = Pick<PlatformView, 'paymentMint' | 'paymentDecimals' | 'paymentSymbol'>

/** The deployment's label for the payment mint, or its address — never a guessed symbol. */
export function paymentLabel(platform: PaymentMint): string {
  return platform.paymentSymbol ?? short(platform.paymentMint)
}

export function formatPayment(amount: bigint | string, platform: PaymentMint): string {
  return `${fromBaseUnits(amount, platform.paymentDecimals)} ${paymentLabel(platform)}`
}

/** `price_per_unit` → the price of one whole share, in payment base units. */
export function pricePerShare(pricePerUnit: bigint | string, tokenDecimals: number): bigint {
  return BigInt(pricePerUnit) * 10n ** BigInt(tokenDecimals)
}

/**
 * "12.50" per share → `price_per_unit`. With a token of `d` decimals the share price in
 * payment base units must divide by 10^d; otherwise the error names the step.
 */
export function pricePerUnitField(
  raw: string,
  tokenDecimals: number,
  platform: PaymentMint,
): { value: bigint } | { error: string } {
  if (raw.trim() === '') return { error: 'required' }
  const perShare = toBaseUnits(raw, platform.paymentDecimals)
  if (perShare === null) {
    return { error: `a number with at most ${platform.paymentDecimals} decimals` }
  }
  if (perShare <= 0n) return { error: 'must be positive' }
  const step = 10n ** BigInt(tokenDecimals)
  if (perShare % step !== 0n) {
    return { error: `in steps of ${formatPayment(step, platform)} per share` }
  }
  return { value: perShare / step }
}
