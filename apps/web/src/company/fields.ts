import { isWalletAddress, type WalletAddress } from '@caprail/shared'

// Form parsing shared by the panel's forms. Every parser is pure and returns either
// the arguments a builder takes or the errors by field — the program would refuse
// the same values, but after a signature and a fee.

export type Parsed<T, F extends string> =
  | { ok: true; value: T }
  | { ok: false; errors: Partial<Record<F, string>> }

export const utf8Bytes = (text: string): number => new TextEncoder().encode(text).length

/** A byte-bounded UTF-8 field (the program measures bytes, not characters). */
export function textBytes(
  raw: string,
  max: number,
  { required = true }: { required?: boolean } = {},
): { value: string } | { error: string } {
  const value = raw.trim()
  if (value === '') return required ? { error: 'required' } : { value }
  const bytes = utf8Bytes(value)
  return bytes > max ? { error: `${bytes} bytes; at most ${max}` } : { value }
}

export function walletField(raw: string): { value: WalletAddress } | { error: string } {
  const value = raw.trim()
  if (value === '') return { error: 'required' }
  return isWalletAddress(value) ? { value } : { error: 'not a wallet address' }
}

/**
 * "1,000,000" or "12.5" in whole tokens → base units for `decimals`. Group separators
 * are ignored; more fractional digits than the token has is an error, not a rounding.
 */
export function toBaseUnits(raw: string, decimals: number): bigint | null {
  const text = raw.replace(/[\s,_']/g, '')
  const match = /^(\d+)(?:\.(\d+))?$/.exec(text)
  if (match?.[1] === undefined) return null
  const fraction = match[2] ?? ''
  if (fraction.length > decimals) return null
  const scaled = `${match[1]}${fraction.padEnd(decimals, '0')}`
  return BigInt(scaled)
}

const U64_MAX = 0xffff_ffff_ffff_ffffn

export function amountField(raw: string, decimals: number): { value: bigint } | { error: string } {
  if (raw.trim() === '') return { error: 'required' }
  const value = toBaseUnits(raw, decimals)
  if (value === null) {
    return {
      error: decimals === 0 ? 'a whole number' : `a number with at most ${decimals} decimals`,
    }
  }
  if (value <= 0n) return { error: 'must be positive' }
  if (value > U64_MAX) return { error: 'too large for a u64' }
  return { value }
}

/** Base units → "1,234.5" for display next to the symbol. */
export function fromBaseUnits(amount: bigint | string, decimals: number): string {
  const value = BigInt(amount)
  const whole = value / 10n ** BigInt(decimals)
  const fraction = (value % 10n ** BigInt(decimals)).toString().padStart(decimals, '0')
  const grouped = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  const trimmed = fraction.replace(/0+$/, '')
  return trimmed === '' ? grouped : `${grouped}.${trimmed}`
}
