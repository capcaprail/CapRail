import { decodeBase58 } from '@caprail/shared'
import {
  Keypair,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  type VersionedTransactionResponse,
} from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import { fromTransactionResponse } from './transaction.ts'

// Deterministic keys: the account list order is part of what the test asserts.
const key = (n: number) => Keypair.fromSeed(new Uint8Array(32).fill(n)).publicKey
const payer = key(1)
const programA = key(2)
const programB = key(3)
const acc = [key(4), key(5), key(6)]
// Inner instruction data arrives base58-encoded, unlike the top-level bytes.
const INNER_DATA_BASE58 = '5Q'
const innerData = decodeBase58(INNER_DATA_BASE58)
if (innerData === null) throw new Error('bad test constant')

function response(): VersionedTransactionResponse {
  const message = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: PublicKey.default.toBase58(),
    instructions: [
      new TransactionInstruction({
        programId: programA,
        keys: [{ pubkey: acc[0] as PublicKey, isSigner: false, isWritable: true }],
        data: Buffer.from([1, 2, 3]),
      }),
      new TransactionInstruction({
        programId: programB,
        keys: [
          { pubkey: acc[1] as PublicKey, isSigner: false, isWritable: false },
          { pubkey: acc[2] as PublicKey, isSigner: false, isWritable: true },
        ],
        data: Buffer.from([9]),
      }),
    ],
  }).compileToV0Message()
  const keys = message.staticAccountKeys.map((k) => k.toBase58())
  const index = (k: PublicKey) => keys.indexOf(k.toBase58())
  // Inner instructions the RPC reports under top-level 0: B called by A with acc[2].
  const meta = {
    err: { InstructionError: [1, { Custom: 7 }] },
    fee: 5000,
    logMessages: ['Program log: x'],
    innerInstructions: [
      {
        index: 0,
        instructions: [
          {
            programIdIndex: index(programB),
            accounts: [index(acc[2] as PublicKey)],
            data: INNER_DATA_BASE58,
          },
        ],
      },
    ],
    loadedAddresses: { writable: [], readonly: [] },
  }
  return {
    slot: 42,
    blockTime: 1_789_000_000,
    transaction: { message, signatures: ['s'] },
    meta,
  } as unknown as VersionedTransactionResponse
}

describe('fromTransactionResponse', () => {
  it('flattens top-level and inner instructions in execution order with resolved keys', () => {
    const tx = fromTransactionResponse('s', response())
    expect(tx).toMatchObject({
      signature: 's',
      slot: 42,
      blockTime: 1_789_000_000,
      logs: ['Program log: x'],
      failed: true,
      err: { InstructionError: [1, { Custom: 7 }] },
    })
    expect(tx.accountKeys?.[0]).toBe(payer.toBase58())
    expect(tx.instructions).toEqual([
      {
        programId: programA.toBase58(),
        accounts: [acc[0]?.toBase58()],
        data: Buffer.from([1, 2, 3]).toString('base64'),
        outer: 0,
      },
      {
        programId: programB.toBase58(),
        accounts: [acc[2]?.toBase58()],
        data: Buffer.from(innerData).toString('base64'),
        outer: 0,
      },
      {
        programId: programB.toBase58(),
        accounts: [acc[1]?.toBase58(), acc[2]?.toBase58()],
        data: Buffer.from([9]).toString('base64'),
        outer: 1,
      },
    ])
  })

  it('treats a missing meta as a transaction with no logs that did not fail', () => {
    const r = response()
    const tx = fromTransactionResponse('s', { ...r, meta: null })
    expect(tx.failed).toBe(false)
    expect(tx.logs).toEqual([])
    expect(tx.instructions).toHaveLength(2)
  })
})
