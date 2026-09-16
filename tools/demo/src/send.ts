// Sending transactions, and what the demo exists for: the numbers.
//
// Every send returns its measurement. The fee, the slot and the block time are the
// subject of SC-010 and SC-011, and reading them in a separate pass would measure a
// different transaction than the one that went through.
import { compileTransaction, type TxPlan, toPlan } from '@caprail/chain'
import { fromTransactionResponse, type ProgramTransaction } from '@caprail/indexer'
import type {
  Connection,
  Keypair,
  PublicKey,
  TransactionInstruction,
  VersionedTransaction,
} from '@solana/web3.js'

/** What the ledger says about a transaction, confirmed or failed. */
export type Landed = {
  readonly signature: string
  readonly slot: number
  /** Unix seconds of the block, `undefined` when the node has no time for the slot yet. */
  readonly blockTime: number | undefined
  /** Wall clock (ms) when this client saw the confirmation — the start of the panel's delay (SC-003/004). */
  readonly confirmedAt: number
  readonly feeLamports: number | undefined
  readonly computeUnits: number | undefined
  readonly logs: readonly string[]
  /** Addresses of the message, in index order — enough for a log parser to name the programs. */
  readonly accountKeys: readonly string[]
  /** The same transaction as the worker's parser receives it — what the fixtures are. */
  readonly transaction: ProgramTransaction
}

export type Sent = Landed & { readonly bytes: number }

/** A transaction the network executed and rejected — it is in the ledger, with logs. */
export type Refused = Landed & {
  /** Custom error code of the program that refused, when it was a program error. */
  readonly code: number | undefined
  /** `CaprailError` variant name parsed from the Anchor log line, or `undefined`. */
  readonly reason: string | undefined
  readonly err: unknown
}

export class TransactionRefused extends Error {
  readonly detail: Refused

  constructor(detail: Refused) {
    super(`transaction refused: ${detail.reason ?? JSON.stringify(detail.err)}`)
    this.name = 'TransactionRefused'
    this.detail = detail
  }
}

/**
 * A transaction that **passed** where a refusal was expected. Its own type, not a
 * plain error: "the transfer went through" fails SC-001, while "the attempt could
 * not even be sent" is a broken measurement — one `catch` for both would show a hole
 * in the rule where there is none.
 */
export class PassedThrough extends Error {
  readonly sent: Sent

  constructor(sent: Sent) {
    super(`the transaction went through and was not supposed to: ${sent.signature}`)
    this.name = 'PassedThrough'
    this.sent = sent
  }
}

// Anchor writes one line per refusal: `AnchorError occurred. Error Code: NotAccredited.
// Error Number: 6000. Error Message: …`. The name is what the journal shows (FR-006);
// the number is the same fact for the `err` object.
const ERROR_LINE = /Error Code: (\w+)\. Error Number: (\d+)\./

export function reasonFromLogs(
  logs: readonly string[],
): { reason: string; code: number } | undefined {
  for (const line of logs) {
    const match = ERROR_LINE.exec(line)
    if (match?.[1] !== undefined && match[2] !== undefined) {
      return { reason: match[1], code: Number(match[2]) }
    }
  }
  return undefined
}

async function landed(
  connection: Connection,
  signature: string,
  confirmedAt: number,
): Promise<Landed & { err: unknown }> {
  // `maxSupportedTransactionVersion` is required: the transactions are v0, and
  // without it the node answers `null` for every one of them.
  const detail = await connection.getTransaction(signature, {
    commitment: 'confirmed',
    maxSupportedTransactionVersion: 0,
  })
  if (detail === null) throw new Error(`confirmed transaction not found: ${signature}`)
  const transaction = fromTransactionResponse(signature, detail)
  return {
    signature,
    slot: detail.slot,
    blockTime: detail.blockTime ?? undefined,
    confirmedAt,
    feeLamports: detail.meta?.fee,
    computeUnits: detail.meta?.computeUnitsConsumed,
    logs: transaction.logs,
    accountKeys: transaction.accountKeys ?? [],
    transaction,
    err: detail.meta?.err ?? null,
  }
}

export async function sign(
  connection: Connection,
  plan: TxPlan,
  signers: readonly Keypair[],
): Promise<VersionedTransaction> {
  const { blockhash } = await connection.getLatestBlockhash()
  const transaction = compileTransaction(plan, blockhash)
  transaction.sign([...signers])
  return transaction
}

/**
 * Sends **without preflight** and waits for the ledger's verdict.
 *
 * Preflight is off on purpose, for every transaction of the demo: a wallet that
 * simulates first never puts a refused transfer on chain, and the point of the demo
 * is a refusal anyone can open in an explorer. The price is that a refused
 * transaction pays its fee — which is also what a third-party wallet would pay.
 */
export async function send(
  connection: Connection,
  transaction: VersionedTransaction,
): Promise<Sent> {
  const bytes = transaction.serialize().length
  const signature = await connection.sendTransaction(transaction, { skipPreflight: true })
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash()
  let failed = false
  try {
    const confirmation = await connection.confirmTransaction(
      { signature, blockhash, lastValidBlockHeight },
      'confirmed',
    )
    failed = confirmation.value.err !== null
  } catch (error) {
    // A race inside web3.js: when the transaction has already landed with an error by
    // the time the status is polled (rather than pushed by the subscription), the
    // promise rejects with the bare `TransactionError` object instead of resolving
    // with it. Same fact, other channel. Real errors (expiry, network) are `Error`s.
    if (error instanceof Error) throw error
    failed = true
  }
  const detail = await landed(connection, signature, Date.now())
  if (failed) {
    const parsed = reasonFromLogs(detail.logs)
    throw new TransactionRefused({ ...detail, reason: parsed?.reason, code: parsed?.code })
  }
  return { ...detail, bytes }
}

/** Sign and send a plan from the builders. */
export async function submitPlan(
  connection: Connection,
  plan: TxPlan,
  signers: readonly Keypair[],
): Promise<Sent> {
  return await send(connection, await sign(connection, plan, signers))
}

/**
 * The same for instructions the builders do not have (funding, token accounts). The
 * step label describes the product's vocabulary; a demo-only instruction borrows the
 * closest one rather than extending that vocabulary for a measurement tool.
 */
export async function submit(
  connection: Connection,
  feePayer: PublicKey,
  instructions: readonly TransactionInstruction[],
  signers: readonly Keypair[],
): Promise<Sent> {
  return await submitPlan(connection, toPlan('transfer', feePayer, instructions), signers)
}

/** An expected refusal: success here **is** the refusal, on chain, with a reason. */
export async function expectRefusal(
  connection: Connection,
  plan: TxPlan,
  signers: readonly Keypair[],
): Promise<Refused> {
  let sent: Sent
  try {
    sent = await submitPlan(connection, plan, signers)
  } catch (error) {
    if (error instanceof TransactionRefused) return error.detail
    throw error
  }
  throw new PassedThrough(sent)
}
