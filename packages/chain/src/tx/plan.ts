import {
  type PublicKey,
  type TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js'

// A transaction plan: the instructions plus what the instructions alone do not say.
//
// The package never signs and never holds a key: the plan goes to wallet-adapter in the
// browser (or to the demo's keypair) as an unsigned `VersionedTransaction`. The list of
// required signers is derived from the instructions rather than declared next to them —
// a second list would drift exactly when an instruction gains a signer, and the wallet
// would then not be asked for the signature that the network rejects the transaction for.

export const TX_STEPS = [
  'create-company',
  'create-token',
  'set-policy',
  'set-roles',
  'set-investor-status',
  'distribute',
  'transfer',
] as const

export type TxStep = (typeof TX_STEPS)[number]

export type TxPlan = {
  readonly step: TxStep
  readonly instructions: readonly TransactionInstruction[]
  /** Pays the fee and signs first. */
  readonly feePayer: PublicKey
  /** Fee payer first, then the other signers in order of appearance. */
  readonly signers: readonly PublicKey[]
}

function requiredSigners(
  instructions: readonly TransactionInstruction[],
  feePayer: PublicKey,
): PublicKey[] {
  const seen = new Set<string>([feePayer.toBase58()])
  const signers = [feePayer]
  for (const instruction of instructions) {
    for (const key of instruction.keys) {
      if (!key.isSigner || seen.has(key.pubkey.toBase58())) continue
      seen.add(key.pubkey.toBase58())
      signers.push(key.pubkey)
    }
  }
  return signers
}

export function toPlan(
  step: TxStep,
  feePayer: PublicKey,
  instructions: readonly TransactionInstruction[],
): TxPlan {
  return { step, instructions, feePayer, signers: requiredSigners(instructions, feePayer) }
}

/** The largest transaction the network accepts, signatures included. */
export const MAX_TRANSACTION_BYTES = 1232

/**
 * Plan + blockhash → unsigned v0 transaction. Pure on purpose: the size of a transaction
 * is only known after compilation, and a size test that needs no node is worth the split.
 */
export function compileTransaction(plan: TxPlan, blockhash: string): VersionedTransaction {
  const message = new TransactionMessage({
    payerKey: plan.feePayer,
    recentBlockhash: blockhash,
    instructions: [...plan.instructions],
  }).compileToV0Message()
  return new VersionedTransaction(message)
}

/**
 * Bytes the transaction will occupy **with all signatures**: `serialize()` on an unsigned
 * transaction writes zeroed signatures of the same size as real ones.
 */
export function transactionBytes(transaction: VersionedTransaction): number {
  return transaction.serialize().length
}
