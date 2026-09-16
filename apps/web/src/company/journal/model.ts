import {
  ATTEMPT_LOG_LINE_LENGTH,
  ATTEMPT_LOG_LINES,
  type AttemptReport,
  isRejectionReason,
  type JournalEntry,
  type WalletAddress,
} from '@caprail/shared'
import type { TxOutcome } from '../../chain/send.ts'

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
}

export function journalCounts(entries: readonly JournalEntry[]): JournalCounts {
  const counts: JournalCounts = {
    attempts: entries.length,
    settled: 0,
    refused: 0,
    refusedOnChain: 0,
    refusedInSimulation: 0,
  }
  for (const entry of entries) {
    if (entry.outcome === 'allowed') {
      counts.settled += 1
      continue
    }
    counts.refused += 1
    if (entry.origin === 'simulation') counts.refusedInSimulation += 1
    else counts.refusedOnChain += 1
  }
  return counts
}

export type JournalFilter = 'all' | 'settled' | 'refused'

export const JOURNAL_FILTERS: ReadonlyArray<{ value: JournalFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'settled', label: 'Settled' },
  { value: 'refused', label: 'Refused' },
]
