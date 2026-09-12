// What the worker hands to the parser: one transaction that mentioned the program,
// as the RPC reports it, whether it succeeded or failed. The parser turns this into
// typed records; the worker knows nothing about event shapes.
export type ProgramTransaction = {
  signature: string
  slot: number
  blockTime: number | null
  logs: string[]
  failed: boolean
  // The RPC's `meta.err`, verbatim: a refusal names the failing top-level instruction.
  err?: unknown
  // Only `getTransaction` carries these; `onLogs` does not. A refused transfer has
  // no event, so its parties come from the instruction — a failed transaction seen
  // through `onLogs` alone yields a rejection without them (`transfer: null`), and
  // the worker fetches the transaction to fill it in.
  accountKeys?: readonly string[]
  instructions?: readonly Instruction[]
}

// One instruction, top-level or inner, in execution order. `outer` is the index of
// the top-level instruction it belongs to — the same number `meta.err` points at.
export type Instruction = {
  programId: string
  accounts: readonly string[]
  // base64
  data: string
  outer: number
}

export type TransactionHandler = (tx: ProgramTransaction) => Promise<void>

export {
  type CompanyCreated,
  decodeEvent,
  EVENT_NAMES,
  type IndexEvent,
  type IndexEventKind,
  type InvestorStatusSet,
  type PolicySet,
  type RolesSet,
  type TokenCreated,
  type TransferAllowed,
  type TransferPolicy,
} from './events.ts'
export { anchorError, attributeLogs, failedInstructionIndex, type LogFrame } from './logs.ts'
export {
  type IndexedEvent,
  type ParsedTransaction,
  parseTransaction,
  type TransferInstruction,
  type TransferRejected,
} from './parse.ts'
export { fromTransactionResponse } from './transaction.ts'
