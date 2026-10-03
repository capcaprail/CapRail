import {
  ATTEMPT_LOG_LINE_LENGTH,
  ATTEMPT_LOG_LINES,
  type AttemptReport,
  isRejectionReason,
  type JournalEntry,
  type JournalTrade,
  type PlatformView,
  type TokenView,
  type WalletAddress,
} from '@caprail/shared'
import type { TxOutcome } from '../../chain/send.ts'
import { formatPayment, pricePerShare } from '../../market/money.ts'

// The journal's pure parts: what a refused simulation reports, and the tallies of
// the loaded page.

// What the worker keeps of a chain row: the tail of the logs, where the refusal
// line is. The schema bounds the line length as the column does.
export function trimLogs(logs: readonly string[]): string[] {
  return logs.slice(-ATTEMPT_LOG_LINES).map((line) => line.slice(0, ATTEMPT_LOG_LINE_LENGTH))
}

// A refusal caught by our simulation is the panel's to report — the chain never saw
// it. One refused on chain (there is a signature) is the worker's: reporting it too
// would show the same attempt twice. A refusal for a reason that is not the hook's
// (a missing account, an expired blockhash) is not a transfer attempt at all.
export function attemptReportFrom(
  transfer: { mint: string; sourceOwner: string; destOwner: WalletAddress; amount: bigint },
  outcome: TxOutcome,
): AttemptReport | null {
  if (outcome.kind !== 'refused' || outcome.signature !== null) return null
  if (!isRejectionReason(outcome.reason)) return null
  return {
    mint: transfer.mint,
    sourceOwner: transfer.sourceOwner,
    destOwner: transfer.destOwner,
    amount: transfer.amount.toString(),
    reasonCode: outcome.reason,
    logs: trimLogs(outcome.logs),
  }
}

export type JournalCounts = {
  attempts: number
  settled: number
  refused: number
  refusedOnChain: number
  refusedInSimulation: number
  // Settled transfers that were market trades, and the platform's fees on them.
  trades: number
  fees: bigint
}

export function journalCounts(entries: readonly JournalEntry[]): JournalCounts {
  const counts: JournalCounts = {
    attempts: entries.length,
    settled: 0,
    refused: 0,
    refusedOnChain: 0,
    refusedInSimulation: 0,
    trades: 0,
    fees: 0n,
  }
  for (const entry of entries) {
    if (entry.outcome === 'allowed') {
      counts.settled += 1
      if (entry.trade !== null) {
        counts.trades += 1
        counts.fees += BigInt(entry.trade.fee)
      }
      continue
    }
    counts.refused += 1
    if (entry.origin === 'simulation') counts.refusedInSimulation += 1
    else counts.refusedOnChain += 1
  }
  return counts
}

export type JournalFilter = 'all' | 'settled' | 'trades' | 'refused'

export const JOURNAL_FILTERS: ReadonlyArray<{ value: JournalFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'settled', label: 'Settled' },
  { value: 'trades', label: 'Trades' },
  { value: 'refused', label: 'Refused' },
]

// The money side of a trade in the journal (FR-013): the price, what the buyer paid,
// the platform's fee out of it and what reached the seller. Named in the payment
// mint the platform labels; a trade in another mint (or a deployment the API could
// not read the platform of) is shown in base units rather than in a guessed currency.
export type TradeLine = {
  price: string
  paid: string
  fee: string
  sellerReceives: string
}

export function tradeLine(
  trade: JournalTrade,
  token: Pick<TokenView, 'decimals'> | undefined,
  platform: PlatformView | null,
): TradeLine {
  const known = platform !== null && platform.paymentMint === trade.paymentMint
  const money = (amount: bigint | string) =>
    known ? formatPayment(amount, platform) : `${amount} base units`
  return {
    price:
      token === undefined
        ? `${money(trade.pricePerUnit)} per unit`
        : `${money(pricePerShare(trade.pricePerUnit, token.decimals))} per share`,
    paid: money(trade.payment),
    fee: money(trade.fee),
    sellerReceives: money(trade.sellerReceives),
  }
}
