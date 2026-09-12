// Pure: a `ProgramTransaction` in, typed records out. No RPC, no clock, no state —
// the same input always gives the same output, which is what lets the fixtures in
// `fixtures/logs/` (real transactions) stand in for the chain.
import { HOOK_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@caprail/chain'
import { decodeEvent, type IndexEvent } from './events.ts'
import type { Instruction, ProgramTransaction } from './index.ts'
import {
  anchorError,
  attributeLogs,
  eventData,
  failedInstructionIndex,
  type LogFrame,
} from './logs.ts'

const HOOK = HOOK_PROGRAM_ID.toBase58()
const TOKEN_2022 = TOKEN_2022_PROGRAM_ID.toBase58()

// Ordinal among the transaction's `Program data:` lines, across all programs —
// with the signature it is the row's identity in `investor_status_events` and
// `transfer_attempts`.
export type IndexedEvent = IndexEvent & { eventIndex: number }

// The `transfer_checked` the hook refused: parties as the instruction names them.
// `destination` is a token account; its owner is not in the instruction (the
// worker resolves it). `sourceOwner` is the signing authority — a wallet, or the
// `Company` PDA when the transfer was a `distribute`.
export type TransferInstruction = {
  mint: string
  source: string
  destination: string
  sourceOwner: string
  amount: bigint
  decimals: number
}

export type TransferRejected = {
  kind: 'TransferRejected'
  // `CaprailError` variant name as the hook logged it: one of the rejection
  // reasons of FR-006, or a service code (`TokenConfigMismatch`, …) for a call
  // that never got as far as the rule.
  reason: string
  errorNumber: number
  // null when the transaction came without instructions (`onLogs`).
  transfer: TransferInstruction | null
}

export type ParsedTransaction = {
  signature: string
  slot: number
  blockTime: number | null
  failed: boolean
  events: IndexedEvent[]
  // Set when the hook is what failed — the only failure that is a journal row.
  rejection: TransferRejected | null
  // Any other Anchor error in the transaction (a `set_policy` refused by the
  // program, say): not a journal row, kept for the worker's log.
  failure: { program: string; code: string; number: number } | null
}

// Token-2022 `TransferChecked`: tag 12, amount u64 LE, decimals u8; accounts
// source, mint, destination, authority, then multisig signers and the hook's tail.
const TRANSFER_CHECKED_TAG = 12
const TRANSFER_CHECKED_DATA_LENGTH = 10

function transferChecked(ix: Instruction): TransferInstruction | null {
  if (ix.programId !== TOKEN_2022) return null
  const data = Buffer.from(ix.data, 'base64')
  if (data.length !== TRANSFER_CHECKED_DATA_LENGTH || data[0] !== TRANSFER_CHECKED_TAG) return null
  const [source, mint, destination, sourceOwner] = ix.accounts
  if (
    source === undefined ||
    mint === undefined ||
    destination === undefined ||
    sourceOwner === undefined
  ) {
    return null
  }
  return {
    mint,
    source,
    destination,
    sourceOwner,
    amount: data.readBigUInt64LE(1),
    decimals: data.readUInt8(9),
  }
}

// The transfer the error belongs to: a `transfer_checked` inside the failed
// top-level instruction (the hook runs as its CPI). Without a failing index the
// first one in the transaction — a transaction with two transfers and no
// `meta.err` does not occur.
function refusedTransfer(tx: ProgramTransaction): TransferInstruction | null {
  if (tx.instructions === undefined) return null
  const outer = failedInstructionIndex(tx.err)
  for (const ix of tx.instructions) {
    if (outer !== null && ix.outer !== outer) continue
    const transfer = transferChecked(ix)
    if (transfer !== null) return transfer
  }
  return null
}

// Ordinal among all `Program data:` lines, ours or not; a failed transaction's
// events never happened — the runtime rolls the whole transaction back, the logs
// stay in the ledger but not in the state.
function collectEvents(frames: LogFrame[], failed: boolean): IndexedEvent[] {
  const events: IndexedEvent[] = []
  let eventIndex = 0
  for (const frame of frames) {
    const data = eventData(frame)
    if (data === null) continue
    const event = failed ? null : decodeEvent(data)
    if (event !== null) events.push({ ...event, eventIndex })
    eventIndex += 1
  }
  return events
}

type Errors = Pick<ParsedTransaction, 'rejection' | 'failure'>

// The first Anchor error line of the transaction, sorted by who threw it: the hook
// refused a transfer (a journal row), or a program instruction was refused (not).
function collectErrors(frames: LogFrame[], tx: ProgramTransaction): Errors {
  const errors: Errors = { rejection: null, failure: null }
  if (!tx.failed) return errors
  for (const frame of frames) {
    const error = anchorError(frame)
    if (error === null) continue
    if (frame.program === HOOK && errors.rejection === null) {
      errors.rejection = {
        kind: 'TransferRejected',
        reason: error.code,
        errorNumber: error.number,
        transfer: refusedTransfer(tx),
      }
    } else if (errors.failure === null) {
      errors.failure = { program: frame.program, code: error.code, number: error.number }
    }
  }
  return errors
}

export function parseTransaction(tx: ProgramTransaction): ParsedTransaction {
  const frames = attributeLogs(tx.logs)
  return {
    signature: tx.signature,
    slot: tx.slot,
    blockTime: tx.blockTime,
    failed: tx.failed,
    events: collectEvents(frames, tx.failed),
    ...collectErrors(frames, tx),
  }
}
