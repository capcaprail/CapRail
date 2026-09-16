import type { CapTable, Holder, TokenView } from '@caprail/shared'
import type { StripSegment } from '../../components/OwnershipStrip.tsx'
import { short } from '../../format.ts'
import { fromBaseUnits } from '../fields.ts'

// The cap table's pure parts: percentages from u64 strings, and the ownership
// strip's segments from the table.

// `part / whole` in percent with two decimals, exact on u64 (no float on the way).
export function percentOf(part: bigint | string, whole: bigint | string): number {
  const total = BigInt(whole)
  if (total === 0n) return 0
  return Number((BigInt(part) * 10_000n) / total) / 100
}

export const percent = (value: number): string => `${value.toFixed(2)} %`

export function amountWithSymbol(amount: bigint | string, token: TokenView): string {
  return `${fromBaseUnits(amount, token.decimals)} ${token.symbol}`
}

export type CapTableTotals = { held: bigint; vested: bigint; unvested: bigint; pct: number }

// Holders only — the treasury is issued, not held, and is its own line.
export function capTableTotals(table: CapTable): CapTableTotals {
  let held = 0n
  let vested = 0n
  let unvested = 0n
  for (const holder of table.holders) {
    held += BigInt(holder.amount)
    vested += BigInt(holder.vested)
    unvested += BigInt(holder.unvested)
  }
  return { held, vested, unvested, pct: percentOf(held, table.totalSupply) }
}

// Largest holders first; the API orders them so, and the strip depends on it.
export function holdersByAmount(holders: readonly Holder[]): Holder[] {
  return [...holders].sort((a, b) => (BigInt(b.amount) > BigInt(a.amount) ? 1 : -1))
}

export function stripSegments(table: CapTable, token: TokenView): StripSegment[] {
  const treasuryPct = percentOf(table.treasury, table.totalSupply)
  const treasury: StripSegment = {
    key: 'treasury',
    label: 'Treasury',
    sharePct: treasuryPct,
    unvestedPct: null,
    treasury: true,
    tip: `Treasury · ${amountWithSymbol(table.treasury, token)} · ${percent(treasuryPct)} · not yet distributed`,
  }
  const holders = holdersByAmount(table.holders).map((holder): StripSegment => {
    const unvested = BigInt(holder.unvested)
    const head = `${short(holder.wallet)} · ${amountWithSymbol(holder.amount, token)} · ${percent(holder.pct)}`
    return {
      key: holder.wallet,
      label: short(holder.wallet),
      sharePct: holder.pct,
      unvestedPct: unvested === 0n ? null : percentOf(unvested, holder.amount),
      treasury: false,
      tip:
        unvested === 0n
          ? head
          : `${head} · of which ${amountWithSymbol(unvested, token)} not yet vested`,
    }
  })
  return [treasury, ...holders]
}
