import { compileTransaction, type TxPlan } from '@caprail/chain'
import type { Connection, VersionedTransaction } from '@solana/web3.js'

// A plan from `packages/chain` → the ledger's verdict, through the wallet.
//
// Simulation comes first and is ours, not the wallet's: a refusal there has the
// program's logs and reason, which the panel shows and reports to the journal as
// `simulation` (`POST /attempts`). Only a plan that passes is put in front of the wallet, so the
// user is not asked to sign what the network would refuse.

export type TxPhase = 'simulating' | 'signing' | 'confirming'

export type TxOutcome =
  | { kind: 'settled'; signature: string; slot: number }
  // The network (in simulation or on chain) refused with a program error; `signature`
  // is null when nothing was sent.
  | { kind: 'refused'; reason: string | null; logs: string[]; signature: string | null }
  // The wallet declined, the blockhash expired, the node did not answer.
  | { kind: 'failed'; message: string }

/** What `useWallet().sendTransaction` is, bound to a wallet. */
export type SendWithWallet = (
  transaction: VersionedTransaction,
  connection: Connection,
) => Promise<string>

export type SubmitDeps = {
  connection: Connection
  send: SendWithWallet
  onPhase?: (phase: TxPhase) => void
}

// Anchor writes one line per refusal: `AnchorError occurred. Error Code: NotAccredited.
// Error Number: 6000. …` — the code is the reason the journal names (FR-006).
const ERROR_LINE = /Error Code: (\w+)\. Error Number: \d+\./

export function reasonFromLogs(logs: readonly string[]): string | null {
  for (const line of logs) {
    const match = ERROR_LINE.exec(line)
    if (match?.[1] !== undefined) return match[1]
  }
  return null
}

// Errors arrive wrapped: wallet-adapter puts the wallet's or the node's error under
// `.error`, and web3.js keeps preflight logs on `.logs`. Dig for the logs, whichever
// layer has them.
export function logsOf(error: unknown): string[] | null {
  let current: unknown = error
  for (let depth = 0; depth < 4 && typeof current === 'object' && current !== null; depth += 1) {
    const logs = (current as { logs?: unknown }).logs
    if (Array.isArray(logs) && logs.every((line) => typeof line === 'string')) return logs
    current = (current as { error?: unknown }).error
  }
  return null
}

export function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return JSON.stringify(error)
}

export async function submitPlan(deps: SubmitDeps, plan: TxPlan): Promise<TxOutcome> {
  const { connection } = deps
  const phase = deps.onPhase ?? (() => undefined)

  phase('simulating')
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash()
  const transaction = compileTransaction(plan, blockhash)
  const simulation = await connection.simulateTransaction(transaction, { sigVerify: false })
  if (simulation.value.err !== null) {
    const logs = simulation.value.logs ?? []
    return { kind: 'refused', reason: reasonFromLogs(logs), logs, signature: null }
  }

  phase('signing')
  let signature: string
  try {
    signature = await deps.send(transaction, connection)
  } catch (error) {
    // Preflight ran again on the node between our simulation and the send; a
    // refusal there carries logs, a declined signature does not.
    const logs = logsOf(error)
    if (logs !== null && logs.length > 0) {
      return { kind: 'refused', reason: reasonFromLogs(logs), logs, signature: null }
    }
    return { kind: 'failed', message: messageOf(error) }
  }

  phase('confirming')
  try {
    const confirmation = await connection.confirmTransaction(
      { signature, blockhash, lastValidBlockHeight },
      'confirmed',
    )
    if (confirmation.value.err === null) {
      return { kind: 'settled', signature, slot: confirmation.context.slot }
    }
  } catch (error) {
    // web3.js rejects with the bare `TransactionError` object when the transaction
    // had already landed with an error by the time the status was polled; a real
    // failure (expiry, network) is an `Error`.
    if (error instanceof Error) return { kind: 'failed', message: error.message }
  }
  // Refused on chain after passing simulation (the state moved in between): the
  // ledger has the logs, and the worker will show the same row in the journal.
  const detail = await connection
    .getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 })
    .catch(() => null)
  const logs = detail?.meta?.logMessages ?? []
  return { kind: 'refused', reason: reasonFromLogs(logs), logs, signature }
}
