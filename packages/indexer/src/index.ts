// What the worker hands to the parser: one transaction that mentioned the program,
// as the RPC reports it, whether it succeeded or failed. The parser turns this into
// typed records; the worker knows nothing about event shapes.
export type ProgramTransaction = {
  signature: string
  slot: number
  blockTime: number | null
  logs: string[]
  failed: boolean
}

export type TransactionHandler = (tx: ProgramTransaction) => Promise<void>
