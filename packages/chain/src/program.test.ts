import { Connection, PublicKey } from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import { IDL } from './idl/caprail.ts'
import { IDL as HOOK_IDL } from './idl/caprailHook.ts'
import { createCaprailProgram, HOOK_PROGRAM_ID, PROGRAM_ID } from './program.ts'

const DECLARED_ID = 'As8C4JwSGHd7HPvh5KD1FhhLsQphQ8veSdhipiSRWs7g'
const DECLARED_HOOK_ID = '6EMZVfUkf2wrtwfnESLghWfdWyzDu71uJTJ7dCKG3YEi'

describe('PROGRAM_ID', () => {
  it('comes from the vendored IDL and matches declare_id!', () => {
    expect(PROGRAM_ID.toBase58()).toBe(IDL.address)
    expect(PROGRAM_ID.equals(new PublicKey(DECLARED_ID))).toBe(true)
  })
})

describe('HOOK_PROGRAM_ID', () => {
  it('is the separate hook program, and the hook IDL names the instruction Token-2022 calls', () => {
    expect(HOOK_PROGRAM_ID.toBase58()).toBe(HOOK_IDL.address)
    expect(HOOK_PROGRAM_ID.equals(new PublicKey(DECLARED_HOOK_ID))).toBe(true)
    expect(HOOK_PROGRAM_ID.equals(PROGRAM_ID)).toBe(false)
    expect(HOOK_IDL.instructions.map((i) => i.name)).toContain('execute')
  })
})

describe('createCaprailProgram', () => {
  const connection = new Connection('http://127.0.0.1:8899')
  const program = createCaprailProgram(connection)

  it('binds the program id and the given connection', () => {
    expect(program.programId.equals(PROGRAM_ID)).toBe(true)
    expect(program.provider.connection).toBe(connection)
  })

  it('has no wallet — read-only by construction', () => {
    expect(program.provider.wallet).toBeUndefined()
    expect(program.provider.publicKey).toBeUndefined()
  })

  it('knows the program error codes from the IDL', () => {
    expect(program.idl.errors?.map((e) => e.code).slice(0, 4)).toEqual([6000, 6001, 6002, 6003])
  })
})
