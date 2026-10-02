import { BN, BorshInstructionCoder, type IdlPda } from '@anchor-lang/core'
import { Connection, PublicKey, type TransactionInstruction } from '@solana/web3.js'
import { expect } from 'vitest'
import { createCaprailProgram, PROGRAM_ID } from '../program.ts'
import type { TxPlan } from '../tx/plan.ts'

// Round-trip helpers for the builder tests. No builder talks to the node: `Program`
// needs a provider only to send, which this package never does.
export const program = createCaprailProgram(new Connection('http://127.0.0.1:8899'))

export function only(plan: TxPlan): TransactionInstruction {
  const [instruction, ...rest] = plan.instructions
  if (instruction === undefined || rest.length > 0) {
    throw new Error(`${plan.step}: expected exactly one instruction`)
  }
  return instruction
}

/**
 * Round trip through the coder. The Anchor coder writes 0 for a field that is missing
 * from the object it is given — the bytes are valid, the meaning is not — so every
 * builder is decoded back and compared field by field.
 */
export function decode(instruction: TransactionInstruction): { name: string; data: unknown } {
  const decoded = new BorshInstructionCoder(program.idl).decode(instruction.data)
  if (decoded === null) throw new Error('instruction data does not decode')
  return { name: decoded.name, data: plain(decoded.data) }
}

// Decoded values in a comparable form: `BN` and `PublicKey` compare by content, not by
// their internal word arrays (a decoded BN carries trailing zero words).
export function plain(value: unknown): unknown {
  // `bn.js` ships no types here, so `instanceof BN` does not narrow; `String()` takes unknown.
  if (value instanceof BN) return String(value)
  if (value instanceof PublicKey) return value.toBase58()
  if (Array.isArray(value)) return value.map(plain)
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, plain(v)]),
    )
  }
  return value
}

function declaredAccounts(name: string) {
  const declared = program.idl.instructions.find((i) => i.name === name)?.accounts
  if (declared === undefined) throw new Error(`${name}: not in the IDL`)
  return declared
}

/** The instruction's accounts against the IDL: same count, same signer/writable flags. */
export function expectAccountsAsDeclared(instruction: TransactionInstruction, name: string) {
  expect(instruction.programId.equals(PROGRAM_ID)).toBe(true)
  expect(instruction.keys.map((k) => [k.isSigner, k.isWritable])).toEqual(
    declaredAccounts(name).map((a) => [
      Boolean('signer' in a && a.signer),
      Boolean('writable' in a && a.writable),
    ]),
  )
}

/**
 * Every account the IDL describes as a PDA, re-derived from the IDL's own seed list —
 * the program's `seeds = [...]`, not the client's `pda.ts` — out of the other accounts
 * of the same instruction and the argument bytes given here (keyed by the IDL path,
 * e.g. `args.offerId`). A seed of the wrong width or order fails here, not on devnet.
 * Returns the names it checked, so a test can assert the list is not empty.
 */
export function expectPdasAsDeclared(
  instruction: TransactionInstruction,
  name: string,
  args: Readonly<Record<string, Uint8Array>> = {},
): string[] {
  const declared = declaredAccounts(name)
  const keyOf = (account: string): PublicKey => {
    const index = declared.findIndex((a) => a.name === account)
    const meta = instruction.keys[index]
    if (meta === undefined) throw new Error(`${name}: no account ${account}`)
    return meta.pubkey
  }
  const checked: string[] = []
  for (const account of declared) {
    // Widened to the generic shape: the literal IDL type is a union with no `program`
    // on the PDAs of this program.
    const pda: IdlPda | undefined = 'pda' in account ? account.pda : undefined
    if (pda === undefined) continue
    const seeds = pda.seeds.map((seed): Uint8Array => {
      if (seed.kind === 'const') return Uint8Array.from(seed.value)
      if (seed.kind === 'account') return keyOf(seed.path).toBytes()
      const bytes = args[seed.path]
      if (bytes === undefined) throw new Error(`${name}: no bytes for argument ${seed.path}`)
      return bytes
    })
    const owner = pda.program
    const programId =
      owner === undefined
        ? PROGRAM_ID
        : owner.kind === 'const'
          ? new PublicKey(Uint8Array.from(owner.value))
          : keyOf(owner.path)
    const [expected] = PublicKey.findProgramAddressSync(seeds, programId)
    expect(keyOf(account.name).toBase58(), `${name}.${account.name}`).toBe(expected.toBase58())
    checked.push(account.name)
  }
  return checked
}

export const keyAt = (instruction: TransactionInstruction, index: number): PublicKey => {
  const meta = instruction.keys[index]
  if (meta === undefined) throw new Error(`no account at ${index}`)
  return meta.pubkey
}
