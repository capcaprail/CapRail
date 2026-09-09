import { type IdlAccounts, Program, type Provider } from '@anchor-lang/core'
import { type Connection, PublicKey } from '@solana/web3.js'
import { type Caprail, IDL } from './idl/caprail.ts'
import { IDL as HOOK_IDL } from './idl/caprailHook.ts'

export const PROGRAM_ID = new PublicKey(IDL.address)

// The transfer hook is a separate program: the one that is a mint's hook cannot itself
// transfer that mint through CPI (indirect reentrancy). Its address travels in the mint's
// `TransferHook` extension; this constant is the same value for builders and the demo.
export const HOOK_PROGRAM_ID = new PublicKey(HOOK_IDL.address)

export type CaprailProgram = Program<Caprail>

export type CaprailAccounts = IdlAccounts<Caprail>

// A provider with a connection and no wallet: the client fetches, decodes and builds
// instructions; signing happens in the browser wallet, so no key ever lives here.
export function createCaprailProgram(connection: Connection): CaprailProgram {
  const provider: Provider = { connection }
  return new Program<Caprail>(IDL, provider)
}
