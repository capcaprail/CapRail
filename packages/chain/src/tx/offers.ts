import { BN } from '@anchor-lang/core'
import { getAssociatedTokenAddressSync } from '@solana/spl-token'
import { ComputeBudgetProgram, type PublicKey, SystemProgram } from '@solana/web3.js'
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  ata,
  extraAccountMetaListPda,
  offerPda,
  platformPda,
  TOKEN_2022_PROGRAM_ID,
  tokenConfigPda,
} from '../pda.ts'
import { type CaprailProgram, HOOK_PROGRAM_ID } from '../program.ts'
import { type TxPlan, toPlan } from './plan.ts'
import { platformFee } from './platform.ts'
import { hookAccounts } from './transfer.ts'

// The secondary market (FR-011, FR-012, FR-013). No escrow: `create_offer` makes the
// `Offer` PDA the delegate of the seller's ATA, and `accept_offer` moves the shares by
// that delegation, the payment and the fee in one instruction.
//
// The builders check what the program would refuse without reading the chain — terms
// and the size of a partial fill — so a wallet is never asked to sign a transaction
// that cannot pass. Balance and delegation are the chain's to judge (`OfferStale`).

const U64_MAX = 0xffff_ffff_ffff_ffffn

/**
 * The money side of taking `amount` units of an offer: what the buyer pays, what the
 * platform keeps, what the seller gets. The API quotes offers with this function and
 * the panel shows it before the buyer signs — the chain then charges exactly it.
 */
export type OfferQuoteAmounts = {
  readonly amount: bigint
  readonly payment: bigint
  readonly fee: bigint
  readonly sellerReceives: bigint
}

/**
 * `Offer::validate_terms`: zero is not an offer, and the payment for the whole amount
 * must fit a u64 — otherwise the last partial fill would overflow in the buyer's hands.
 */
export function validateOfferTerms(amount: bigint, pricePerUnit: bigint): void {
  if (amount <= 0n || pricePerUnit <= 0n) {
    throw new RangeError(`amount and price must be positive: ${amount} × ${pricePerUnit}`)
  }
  if (amount * pricePerUnit > U64_MAX) {
    throw new RangeError(`payment for ${amount} × ${pricePerUnit} does not fit a u64`)
  }
}

/**
 * `Offer::payment_for` + `PlatformConfig::fee_for`: the price is per minimal unit of the
 * token in minimal units of the payment mint, so the payment is a product with no
 * division, and only the fee rounds — down.
 */
export function quoteOffer(
  feeBps: number,
  pricePerUnit: bigint,
  amount: bigint,
): OfferQuoteAmounts {
  validateOfferTerms(amount, pricePerUnit)
  const payment = amount * pricePerUnit
  const fee = platformFee(feeBps, payment)
  return { amount, payment, fee, sellerReceives: payment - fee }
}

export type CreateOfferArgs = {
  readonly seller: PublicKey
  readonly mint: PublicKey
  /** Chosen by the seller; a taken id — even of a cancelled offer — fails `init`. */
  readonly offerId: bigint
  /** In minimal units of the company's token. */
  readonly amount: bigint
  /** Per minimal unit of the token, in minimal units of the platform's payment mint. */
  readonly pricePerUnit: bigint
}

export async function buildCreateOffer(
  program: CaprailProgram,
  args: CreateOfferArgs,
): Promise<TxPlan> {
  validateOfferTerms(args.amount, args.pricePerUnit)

  const instruction = await program.methods
    .createOffer({
      offerId: new BN(args.offerId.toString()),
      amount: new BN(args.amount.toString()),
      pricePerUnit: new BN(args.pricePerUnit.toString()),
    })
    .accountsStrict({
      seller: args.seller,
      platform: platformPda(),
      tokenConfig: tokenConfigPda(args.mint),
      mint: args.mint,
      sellerTokenAccount: ata(args.seller, args.mint),
      offer: offerPda(args.mint, args.seller, args.offerId),
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .instruction()

  return toPlan('create-offer', args.seller, [instruction])
}

export type CancelOfferArgs = {
  readonly seller: PublicKey
  readonly mint: PublicKey
  readonly offerId: bigint
}

export async function buildCancelOffer(
  program: CaprailProgram,
  args: CancelOfferArgs,
): Promise<TxPlan> {
  const instruction = await program.methods
    .cancelOffer()
    .accountsStrict({
      seller: args.seller,
      offer: offerPda(args.mint, args.seller, args.offerId),
      mint: args.mint,
      sellerTokenAccount: ata(args.seller, args.mint),
      tokenProgram: TOKEN_2022_PROGRAM_ID,
    })
    .instruction()

  return toPlan('cancel-offer', args.seller, [instruction])
}

/**
 * The heaviest `accept_offer` measured — both ATAs created — is ≈ 188.7k CU, 6 % under
 * the default 200k. The hook's PDA derivations search bumps, and that cost moves with
 * the wallets involved, so the limit is set explicitly with room above the measurement.
 */
export const ACCEPT_OFFER_COMPUTE_UNITS = 240_000

/** The terms of the offer as indexed; the quote is computed from them. */
export type OfferTerms = {
  readonly mint: PublicKey
  readonly seller: PublicKey
  readonly offerId: bigint
  readonly pricePerUnit: bigint
  readonly remaining: bigint
}

/** `PlatformConfig` as read from the chain, plus the program its payment mint lives on. */
export type PlatformTerms = {
  readonly feeBps: number
  readonly paymentMint: PublicKey
  readonly feeTreasury: PublicKey
  /** The stablecoin may live on the classic token program; the shares never do. */
  readonly paymentTokenProgram: PublicKey
}

export type AcceptOfferArgs = {
  readonly buyer: PublicKey
  readonly offer: OfferTerms
  readonly platform: PlatformTerms
  /** 1..=remaining; less than `remaining` is a partial fill. */
  readonly amount: bigint
  /** Any token account of the payment mint the buyer owns; the buyer's ATA by default. */
  readonly buyerPaymentAccount?: PublicKey
}

/** The plan carries the quote it was built for, so what the buyer sees is what they sign. */
export type AcceptOfferPlan = TxPlan & { readonly quote: OfferQuoteAmounts }

export async function buildAcceptOffer(
  program: CaprailProgram,
  args: AcceptOfferArgs,
): Promise<AcceptOfferPlan> {
  const { buyer, offer, platform, amount } = args
  if (amount > offer.remaining) {
    throw new RangeError(`amount ${amount} exceeds the remaining ${offer.remaining}`)
  }
  const quote = quoteOffer(platform.feeBps, offer.pricePerUnit, amount)

  const paymentAta = (owner: PublicKey) =>
    getAssociatedTokenAddressSync(platform.paymentMint, owner, true, platform.paymentTokenProgram)
  // Investor record of the buyer, grant and permit of the seller — the transfer of the
  // shares is seller → buyer.
  const hook = hookAccounts(offer.mint, offer.seller, buyer)

  const instruction = await program.methods
    .acceptOffer(new BN(amount.toString()))
    .accountsStrict({
      buyer,
      platform: platformPda(),
      offer: offerPda(offer.mint, offer.seller, offer.offerId),
      seller: offer.seller,
      tokenConfig: hook.tokenConfig,
      mint: offer.mint,
      sellerTokenAccount: ata(offer.seller, offer.mint),
      buyerTokenAccount: ata(buyer, offer.mint),
      paymentMint: platform.paymentMint,
      buyerPaymentAccount: args.buyerPaymentAccount ?? paymentAta(buyer),
      sellerPaymentAccount: paymentAta(offer.seller),
      feeTreasury: platform.feeTreasury,
      extraAccountMetaList: extraAccountMetaListPda(offer.mint),
      stateProgram: hook.stateProgram,
      investorRecord: hook.investorRecord,
      grant: hook.grant,
      transferPermit: hook.transferPermit,
      hookProgram: HOOK_PROGRAM_ID,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      paymentTokenProgram: platform.paymentTokenProgram,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .instruction()

  const budget = ComputeBudgetProgram.setComputeUnitLimit({ units: ACCEPT_OFFER_COMPUTE_UNITS })
  return { ...toPlan('accept-offer', buyer, [budget, instruction]), quote }
}
