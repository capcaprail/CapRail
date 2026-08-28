// Ledger conventions from the brief: units after every amount, no bare numbers, no `$`.

export const vhi = (n: number): string => `${n.toLocaleString('en-US')} VHI`

export const dusd = (cents: number): string =>
  `${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} dUSD`

export const pct = (p: number): string => `${p.toFixed(1)} %`

/** `Vhi5KesseDemo…5yUa` → `Vhi5…5yUa`; already-short strings pass through. */
export const short = (address: string): string =>
  address.length > 12 ? `${address.slice(0, 4)}…${address.slice(-4)}` : address

/** Fee taken from the buyer's payment, in cents, rounded to the cent. */
export const feeFor = (totalCents: number, bps: number): number =>
  Math.round((totalCents * bps) / 10_000)

/** Digits only — the quantity inputs accept "5,000" and "5000" alike. */
export const parseWhole = (raw: string): number => {
  const digits = raw.replace(/[^0-9]/g, '')
  return digits ? Number.parseInt(digits, 10) : 0
}

/** "4.50" → 450; anything unparsable → 0. */
export const parseCents = (raw: string): number => {
  const n = Number.parseFloat(raw.replace(/[^0-9.]/g, ''))
  return Number.isNaN(n) ? 0 : Math.round(n * 100)
}
