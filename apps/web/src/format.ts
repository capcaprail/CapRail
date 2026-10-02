// Ledger conventions from the brief: units after every amount, no bare numbers, no `$`.

export const pct = (p: number): string => `${p.toFixed(1)} %`

/** `Vhi5KesseDemo…5yUa` → `Vhi5…5yUa`; already-short strings pass through. */
export const short = (address: string): string =>
  address.length > 12 ? `${address.slice(0, 4)}…${address.slice(-4)}` : address

/** ISO time → `2026-09-14`, UTC. */
export const utcDate = (iso: string): string => iso.slice(0, 10)

/** ISO time → `2026-09-14 12:34 UTC`. */
export const utcDateTime = (iso: string): string => {
  const date = new Date(iso)
  const hh = String(date.getUTCHours()).padStart(2, '0')
  const mm = String(date.getUTCMinutes()).padStart(2, '0')
  return `${date.toISOString().slice(0, 10)} ${hh}:${mm} UTC`
}
