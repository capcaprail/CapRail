import { BN } from '@anchor-lang/core'
import { addExtraAccountMetasForExecute, createTransferCheckedInstruction } from '@solana/spl-token'
import { type AccountMeta, type Connection, type PublicKey, SystemProgram } from '@solana/web3.js'
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  ata,
  extraAccountMetaListPda,
  grantPda,
  investorRecordPda,
  TOKEN_2022_PROGRAM_ID,
  tokenConfigPda,
  transferPermitPda,
  treasuryAta,
} from '../pda.ts'
import { type CaprailProgram, HOOK_PROGRAM_ID, PROGRAM_ID } from '../program.ts'
import { type TxPlan, toPlan } from './plan.ts'

// Transfers through the hook (FR-001, FR-005). Two paths, one tail of accounts:
//
// - `distribute` is a `caprail` instruction; the IDL names the hook's state accounts
//   explicitly, so the client derives them offline (`hookAccounts`).
// - a wallet-to-wallet transfer is a plain Token-2022 `transfer_checked`; its tail is
//   resolved from the on-chain `ExtraAccountMetaList` by `@solana/spl-token`, exactly as
//   any third-party wallet would — with three RPC reads (the list, source, destination).
//
// `tx.test.ts` proves the two agree on the list the program actually writes
// (`fixtures/hook-extra-account-metas.json`).

/** The state accounts the hook reads, in the order of the on-chain list. */
export type HookAccounts = {
  readonly stateProgram: PublicKey
  readonly tokenConfig: PublicKey
  /** Of the **recipient** — admission is checked on the receiving side. */
  readonly investorRecord: PublicKey
  /** Of the **sender** — vesting (US3) limits what leaves. */
  readonly grant: PublicKey
  /** Keyed by the source token account (US2). */
  readonly transferPermit: PublicKey
}

export function hookAccounts(
  mint: PublicKey,
  sender: PublicKey,
  recipient: PublicKey,
): HookAccounts {
  return {
    stateProgram: PROGRAM_ID,
    tokenConfig: tokenConfigPda(mint),
    investorRecord: investorRecordPda(mint, recipient),
    grant: grantPda(mint, sender),
    transferPermit: transferPermitPda(ata(sender, mint)),
  }
}

export type DistributeArgs = {
  readonly company: PublicKey
  readonly mint: PublicKey
  readonly admin: PublicKey
  readonly investor: PublicKey
  readonly amount: bigint
}

/**
 * Treasury → investor. The investor's ATA is created in the same instruction when it
 * does not exist, at the administrator's expense; the recipient's admission is checked
 * by the hook, not here.
 */
export async function buildDistribute(
  program: CaprailProgram,
  args: DistributeArgs,
): Promise<TxPlan> {
  const hook = hookAccounts(args.mint, args.company, args.investor)
  const instruction = await program.methods
    .distribute(new BN(args.amount.toString()))
    .accountsStrict({
      admin: args.admin,
      company: args.company,
      tokenConfig: hook.tokenConfig,
      mint: args.mint,
      treasury: treasuryAta(args.company, args.mint),
      investor: args.investor,
      investorTokenAccount: ata(args.investor, args.mint),
      extraAccountMetaList: extraAccountMetaListPda(args.mint),
      stateProgram: hook.stateProgram,
      investorRecord: hook.investorRecord,
      grant: hook.grant,
      transferPermit: hook.transferPermit,
      hookProgram: HOOK_PROGRAM_ID,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .instruction()

  return toPlan('distribute', args.admin, [instruction])
}

export type TransferArgs = {
  readonly mint: PublicKey
  readonly owner: PublicKey
  readonly recipient: PublicKey
  readonly amount: bigint
  /**
   * Declared by the caller, as `transfer_checked` intends: the token program rejects a
   * mismatch with the mint. Reading it here would check the mint against itself.
   */
  readonly decimals: number
}

/**
 * Wallet → wallet between the parties' ATAs, with the hook's tail resolved on-chain.
 *
 * The recipient's ATA must already exist: this path creates nothing (the sender would
 * otherwise pay rent for someone else's account). `distribute` is the path that creates.
 */
export async function buildTransfer(connection: Connection, args: TransferArgs): Promise<TxPlan> {
  const source = ata(args.owner, args.mint)
  const destination = ata(args.recipient, args.mint)
  const instruction = createTransferCheckedInstruction(
    source,
    args.mint,
    destination,
    args.owner,
    args.amount,
    args.decimals,
    [],
    TOKEN_2022_PROGRAM_ID,
  )

  // spl-token silently returns the bare instruction when the list account is missing —
  // and the network would then reject the transfer with a Token-2022 error instead of a
  // named reason. A token without its list is not a CapRail token; fail loudly.
  const before = instruction.keys.length
  await addExtraAccountMetasForExecute(
    connection,
    instruction,
    HOOK_PROGRAM_ID,
    source,
    args.mint,
    destination,
    args.owner,
    args.amount,
  )
  if (instruction.keys.length === before) {
    throw new Error(`no ExtraAccountMetaList for mint ${args.mint.toBase58()}`)
  }

  return toPlan('transfer', args.owner, [instruction])
}

/** The tail `buildTransfer` appends, in spl-token's order — for tests and the demo. */
export function expectedTransferTail(
  mint: PublicKey,
  sender: PublicKey,
  recipient: PublicKey,
): AccountMeta[] {
  const hook = hookAccounts(mint, sender, recipient)
  return [
    hook.stateProgram,
    hook.tokenConfig,
    hook.investorRecord,
    hook.grant,
    hook.transferPermit,
    HOOK_PROGRAM_ID,
    extraAccountMetaListPda(mint),
  ].map((pubkey) => ({ pubkey, isSigner: false, isWritable: false }))
}
