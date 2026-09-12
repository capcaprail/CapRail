import { decodeBase58 } from '@caprail/shared'
import type { VersionedTransactionResponse } from '@solana/web3.js'
import type { Instruction, ProgramTransaction } from './index.ts'

// `getTransaction` → the parser's input. One place turns the RPC's two instruction
// encodings (compiled top-level with byte data, inner with base58 data) and its
// split account list (static + lookup-loaded) into the flat form the parser reads;
// the demo dumps fixtures through the same function, so a fixture is exactly what
// the worker would have seen.
export function fromTransactionResponse(
  signature: string,
  tx: VersionedTransactionResponse,
): ProgramTransaction {
  const message = tx.transaction.message
  const keys = message.getAccountKeys({
    accountKeysFromLookups: tx.meta?.loadedAddresses ?? null,
  })
  const accountKeys: string[] = []
  for (let i = 0; i < keys.length; i++) {
    const key = keys.get(i)
    if (key === undefined) throw new Error(`${signature}: account key ${i} missing`)
    accountKeys.push(key.toBase58())
  }
  const at = (index: number): string => {
    const key = accountKeys[index]
    if (key === undefined) throw new Error(`${signature}: account index ${index} out of range`)
    return key
  }

  const inner = new Map<number, Instruction[]>()
  for (const group of tx.meta?.innerInstructions ?? []) {
    inner.set(
      group.index,
      group.instructions.map((ix) => {
        const bytes = decodeBase58(ix.data)
        if (bytes === null) throw new Error(`${signature}: inner instruction data is not base58`)
        return {
          programId: at(ix.programIdIndex),
          accounts: ix.accounts.map(at),
          data: Buffer.from(bytes).toString('base64'),
          outer: group.index,
        }
      }),
    )
  }

  const instructions: Instruction[] = []
  message.compiledInstructions.forEach((ix, index) => {
    instructions.push({
      programId: at(ix.programIdIndex),
      accounts: ix.accountKeyIndexes.map(at),
      data: Buffer.from(ix.data).toString('base64'),
      outer: index,
    })
    instructions.push(...(inner.get(index) ?? []))
  })

  return {
    signature,
    slot: tx.slot,
    blockTime: tx.blockTime ?? null,
    logs: tx.meta?.logMessages ?? [],
    failed: tx.meta?.err != null,
    err: tx.meta?.err ?? null,
    accountKeys,
    instructions,
  }
}
