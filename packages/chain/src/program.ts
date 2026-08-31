import { type IdlAccounts, Program, type Provider } from '@anchor-lang/core'
import { type Connection, PublicKey } from '@solana/web3.js'
import { type Caprail, IDL } from './idl/caprail.ts'

export const PROGRAM_ID = new PublicKey(IDL.address)

export type CaprailProgram = Program<Caprail>

export type CaprailAccounts = IdlAccounts<Caprail>

// A provider with a connection and no wallet: the client fetches, decodes and builds
// instructions; signing happens in the browser wallet, so no key ever lives here.
export function createCaprailProgram(connection: Connection): CaprailProgram {
  const provider: Provider = { connection }
  return new Program<Caprail>(IDL, provider)
}
