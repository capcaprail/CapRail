import { BN } from '@anchor-lang/core'
import type { PublicKey } from '@solana/web3.js'
import { SystemProgram } from '@solana/web3.js'
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  extraAccountMetaListPda,
  mintPda,
  TOKEN_2022_PROGRAM_ID,
  tokenConfigPda,
  treasuryAta,
} from '../pda.ts'
import { type CaprailProgram, HOOK_PROGRAM_ID } from '../program.ts'
import { type TxPlan, toPlan } from './plan.ts'

// Token creation and policy (FR-001, FR-002). The mint is issued once, in full, to the
// treasury; there is no mint-more instruction.

// Byte limits of `create_token` (`programs/caprail/src/instructions/create_token.rs`).
// The program measures bytes, not characters.
export const TOKEN_NAME_MAX_BYTES = 32
export const TOKEN_SYMBOL_MAX_BYTES = 10
export const TOKEN_URI_MAX_BYTES = 200
export const DECIMALS_MAX = 9

export type TransferPolicyInput = {
  readonly requireAccreditation: boolean
  /** Rejected by the program until M4 — the ROFR mechanism does not exist yet. */
  readonly requireRofr: boolean
  readonly rofrWindowSecs: number
}

export type CreateTokenArgs = {
  readonly company: PublicKey
  readonly admin: PublicKey
  /**
   * `Company.token_count` at the moment of creation. Passed in rather than read here so
   * the builder stays pure; the panel reads the company account first anyway.
   */
  readonly tokenIndex: number
  readonly name: string
  readonly symbol: string
  /** May be empty: wallets show name and symbol without a link. */
  readonly uri: string
  readonly decimals: number
  readonly totalSupply: bigint
  readonly policy: TransferPolicyInput
}

/** Addresses a token creation touches — known before the transaction is sent. */
export function tokenAddresses(company: PublicKey, tokenIndex: number) {
  const mint = mintPda(company, tokenIndex)
  return {
    mint,
    tokenConfig: tokenConfigPda(mint),
    treasury: treasuryAta(company, mint),
    extraAccountMetaList: extraAccountMetaListPda(mint),
  }
}

export async function buildCreateToken(
  program: CaprailProgram,
  args: CreateTokenArgs,
): Promise<TxPlan> {
  const addresses = tokenAddresses(args.company, args.tokenIndex)
  const instruction = await program.methods
    .createToken({
      name: args.name,
      symbol: args.symbol,
      uri: args.uri,
      decimals: args.decimals,
      totalSupply: new BN(args.totalSupply.toString()),
      policy: args.policy,
    })
    .accountsStrict({
      admin: args.admin,
      company: args.company,
      ...addresses,
      hookProgram: HOOK_PROGRAM_ID,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .instruction()

  return toPlan('create-token', args.admin, [instruction])
}

export type SetPolicyArgs = {
  readonly company: PublicKey
  readonly mint: PublicKey
  readonly admin: PublicKey
  readonly policy: TransferPolicyInput
}

export async function buildSetPolicy(
  program: CaprailProgram,
  args: SetPolicyArgs,
): Promise<TxPlan> {
  const instruction = await program.methods
    .setPolicy(args.policy)
    .accountsStrict({
      admin: args.admin,
      company: args.company,
      tokenConfig: tokenConfigPda(args.mint),
    })
    .instruction()

  return toPlan('set-policy', args.admin, [instruction])
}
