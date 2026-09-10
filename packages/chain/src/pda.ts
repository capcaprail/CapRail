import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  getExtraAccountMetaAddress,
  TOKEN_2022_PROGRAM_ID,
} from '@solana/spl-token'
import { PublicKey } from '@solana/web3.js'
import { HOOK_PROGRAM_ID, PROGRAM_ID } from './program.ts'

const utf8 = new TextEncoder()

// Seed labels. They must equal the constants in `programs/caprail/src/state/` and
// `programs/caprail/src/hook/extra_account_metas.rs`; `pda.test.ts` pins every derived
// address against `fixtures/hook-extra-account-metas.json`, which the Rust test in turn
// pins against the program — so a drift here fails the gate, not the first transfer.
export const SEED = {
  company: utf8.encode('company'),
  mint: utf8.encode('mint'),
  token: utf8.encode('token'),
  investor: utf8.encode('investor'),
  grant: utf8.encode('grant'),
  permit: utf8.encode('permit'),
} as const

export { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID }

// Little-endian, exactly the width of the Rust field: this is what `to_le_bytes()` gives
// Anchor in `seeds = [...]`. A wrong width does not fail to compile or to type — it derives
// another address, and shows up as `ConstraintSeeds` on devnet.
export function u64Le(value: bigint): Uint8Array {
  if (value < 0n || value > 0xffff_ffff_ffff_ffffn)
    throw new RangeError(`u64 out of range: ${value}`)
  const bytes = new Uint8Array(8)
  new DataView(bytes.buffer).setBigUint64(0, value, true)
  return bytes
}

export function u32Le(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new RangeError(`u32 out of range: ${value}`)
  }
  const bytes = new Uint8Array(4)
  new DataView(bytes.buffer).setUint32(0, value, true)
  return bytes
}

const derive = (seeds: Uint8Array[], programId: PublicKey): PublicKey =>
  PublicKey.findProgramAddressSync(seeds, programId)[0]

/** `Company` — one per `companyId`, chosen by the client; a taken id fails `init`. */
export function companyPda(companyId: bigint): PublicKey {
  return derive([SEED.company, u64Le(companyId)], PROGRAM_ID)
}

/**
 * The mint of a company's token. `tokenIndex` is `Company.token_count` at creation time,
 * so the next token of the same company gets the next index and another address.
 */
export function mintPda(company: PublicKey, tokenIndex: number): PublicKey {
  return derive([SEED.mint, company.toBytes(), u32Le(tokenIndex)], PROGRAM_ID)
}

export function tokenConfigPda(mint: PublicKey): PublicKey {
  return derive([SEED.token, mint.toBytes()], PROGRAM_ID)
}

/** The recipient's admission record; its absence means "not admitted", not an error. */
export function investorRecordPda(mint: PublicKey, wallet: PublicKey): PublicKey {
  return derive([SEED.investor, mint.toBytes(), wallet.toBytes()], PROGRAM_ID)
}

/** The sender's grant (US3). Until grants exist the hook reads an empty account here. */
export function grantPda(mint: PublicKey, wallet: PublicKey): PublicKey {
  return derive([SEED.grant, mint.toBytes(), wallet.toBytes()], PROGRAM_ID)
}

/**
 * The transfer permit (US2) is keyed by the source **token account**, not its owner: it
 * lives for one instruction and is bound to the account the tokens leave.
 */
export function transferPermitPda(source: PublicKey): PublicKey {
  return derive([SEED.permit, source.toBytes()], PROGRAM_ID)
}

/** The hook's `ExtraAccountMetaList` — a PDA of the hook program, not of `caprail`. */
export function extraAccountMetaListPda(mint: PublicKey): PublicKey {
  return getExtraAccountMetaAddress(mint, HOOK_PROGRAM_ID)
}

/**
 * Associated token account under Token-2022. `allowOwnerOffCurve` is on because the
 * treasury's owner is the `Company` PDA — the only account in the product that is not
 * a wallet.
 */
export function ata(owner: PublicKey, mint: PublicKey): PublicKey {
  return getAssociatedTokenAddressSync(mint, owner, true, TOKEN_2022_PROGRAM_ID)
}

export function treasuryAta(company: PublicKey, mint: PublicKey): PublicKey {
  return ata(company, mint)
}
