import {
  getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token'
import {
  ComputeBudgetInstruction,
  ComputeBudgetProgram,
  PublicKey,
  type TransactionInstruction,
} from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import { offerPda, platformPda, tokenConfigPda, u64Le } from '../pda.ts'
import { HOOK_PROGRAM_ID, PROGRAM_ID } from '../program.ts'
import { loadHookFixture } from '../test/hook-fixture.ts'
import {
  decode,
  expectAccountsAsDeclared,
  expectPdasAsDeclared,
  keyAt,
  only,
  program,
} from '../test/instructions.ts'
import {
  ACCEPT_OFFER_COMPUTE_UNITS,
  type AcceptOfferArgs,
  buildAcceptOffer,
  buildCancelOffer,
  buildCreateOffer,
  quoteOffer,
} from './offers.ts'
import { compileTransaction, MAX_TRANSACTION_BYTES, transactionBytes } from './plan.ts'
import { platformFee } from './platform.ts'

// Seller and buyer are the fixture's sender and recipient: the hook accounts the program
// wrote into its on-chain list for that pair (`fixtures/hook-extra-account-metas.json`)
// are then the ones `accept_offer` must carry.
const fixture = loadHookFixture()
const SELLER = fixture.sender
const BUYER = fixture.recipient

const U64_MAX = 0xffff_ffff_ffff_ffffn
// Above 2⁶³: a signed or 53-bit path anywhere would show up as another address.
const OFFER_ID = 0x8000_0000_0000_0001n
const BLOCKHASH = '11111111111111111111111111111111'

const PAYMENT_MINT = new PublicKey('SysvarS1otHashes111111111111111111111111111')
const FEE_TREASURY = new PublicKey('SysvarS1otHistory11111111111111111111111111')

describe('offer address', () => {
  it('is derived with the seeds the program declares — the u64 id little-endian', async () => {
    for (const offerId of [0n, 1n, OFFER_ID, U64_MAX]) {
      const instruction = only(
        await buildCreateOffer(program, {
          seller: SELLER,
          mint: fixture.mint,
          offerId,
          amount: 1n,
          pricePerUnit: 1n,
        }),
      )
      expect(keyAt(instruction, 5).equals(offerPda(fixture.mint, SELLER, offerId))).toBe(true)
      expect(expectPdasAsDeclared(instruction, 'createOffer', { 'args.offerId': u64Le(offerId) }))
        // The ATA is declared too: Anchor writes `associated_token::*` as seeds.
        .toEqual(['platform', 'sellerTokenAccount', 'offer'])
    }
  })

  it('differs per seller, per mint and per id', () => {
    const base = offerPda(fixture.mint, SELLER, 1n)
    expect(base.equals(offerPda(fixture.mint, SELLER, 2n))).toBe(false)
    expect(base.equals(offerPda(fixture.mint, BUYER, 1n))).toBe(false)
    expect(base.equals(offerPda(PAYMENT_MINT, SELLER, 1n))).toBe(false)
    expect(() => offerPda(fixture.mint, SELLER, U64_MAX + 1n)).toThrow(RangeError)
  })
})

describe('createOffer', () => {
  const args = {
    seller: SELLER,
    mint: fixture.mint,
    offerId: OFFER_ID,
    amount: 600n,
    pricePerUnit: 250_000n,
  }

  it('round-trips the three u64 terms', async () => {
    const instruction = only(await buildCreateOffer(program, args))
    expect(decode(instruction)).toEqual({
      name: 'createOffer',
      data: {
        args: { offerId: OFFER_ID.toString(), amount: '600', pricePerUnit: '250000' },
      },
    })
  })

  it('the seller alone signs and pays; the token config and ATA are of this mint', async () => {
    const plan = await buildCreateOffer(program, args)
    const instruction = only(plan)
    expectAccountsAsDeclared(instruction, 'createOffer')
    expect(plan.signers).toEqual([SELLER])
    expect(plan.feePayer.equals(SELLER)).toBe(true)
    expect(keyAt(instruction, 1).equals(platformPda())).toBe(true)
    expect(keyAt(instruction, 2).equals(fixture.tokenConfig)).toBe(true)
    expect(keyAt(instruction, 4).equals(fixture.source)).toBe(true)
    expect(keyAt(instruction, 6).equals(TOKEN_2022_PROGRAM_ID)).toBe(true)
  })

  it('refuses the terms `validate_terms` refuses, before the wallet is asked', async () => {
    const refused = [
      { amount: 0n },
      { pricePerUnit: 0n },
      { amount: -1n },
      // The payment for the whole amount must fit a u64.
      { amount: 2n, pricePerUnit: U64_MAX / 2n + 1n },
      { amount: U64_MAX + 1n, pricePerUnit: 1n },
    ]
    for (const terms of refused) {
      await expect(buildCreateOffer(program, { ...args, ...terms })).rejects.toThrow(RangeError)
    }
    // The edge itself is an offer.
    await expect(
      buildCreateOffer(program, { ...args, amount: U64_MAX, pricePerUnit: 1n }),
    ).resolves.toBeDefined()
  })
})

describe('cancelOffer', () => {
  it('carries no arguments and addresses the seller’s offer and ATA', async () => {
    const plan = await buildCancelOffer(program, {
      seller: SELLER,
      mint: fixture.mint,
      offerId: OFFER_ID,
    })
    const instruction = only(plan)
    expectAccountsAsDeclared(instruction, 'cancelOffer')
    expect(decode(instruction)).toEqual({ name: 'cancelOffer', data: {} })
    expect(plan.signers).toEqual([SELLER])
    expect(keyAt(instruction, 1).equals(offerPda(fixture.mint, SELLER, OFFER_ID))).toBe(true)
    expect(keyAt(instruction, 2).equals(fixture.mint)).toBe(true)
    expect(expectPdasAsDeclared(instruction, 'cancelOffer')).toEqual(['sellerTokenAccount'])
  })
})

describe('acceptOffer', () => {
  const args: AcceptOfferArgs = {
    buyer: BUYER,
    offer: {
      mint: fixture.mint,
      seller: SELLER,
      offerId: OFFER_ID,
      pricePerUnit: 250_000n,
      remaining: 600n,
    },
    platform: {
      feeBps: 250,
      paymentMint: PAYMENT_MINT,
      feeTreasury: FEE_TREASURY,
      paymentTokenProgram: TOKEN_2022_PROGRAM_ID,
    },
    amount: 150n,
  }

  const split = (instructions: readonly TransactionInstruction[]) => {
    const [budget, accept, ...rest] = instructions
    if (budget === undefined || accept === undefined || rest.length > 0) {
      throw new Error('expected the budget and the instruction')
    }
    return { budget, accept }
  }

  it('sets the compute limit first, then the instruction with the amount', async () => {
    const plan = await buildAcceptOffer(program, args)
    const { budget, accept } = split(plan.instructions)
    expect(budget.programId.equals(ComputeBudgetProgram.programId)).toBe(true)
    expect(ComputeBudgetInstruction.decodeSetComputeUnitLimit(budget).units).toBe(
      ACCEPT_OFFER_COMPUTE_UNITS,
    )
    // Above the heaviest path measured by `tests/accept_offer.rs`, under the tx maximum.
    expect(ACCEPT_OFFER_COMPUTE_UNITS).toBeGreaterThan(188_683)
    expect(ACCEPT_OFFER_COMPUTE_UNITS).toBeLessThanOrEqual(1_400_000)
    expect(decode(accept)).toEqual({ name: 'acceptOffer', data: { amount: '150' } })
  })

  it('the buyer alone signs — the seller consented by delegation in create_offer', async () => {
    const plan = await buildAcceptOffer(program, args)
    const { accept } = split(plan.instructions)
    expectAccountsAsDeclared(accept, 'acceptOffer')
    expect(plan.signers).toEqual([BUYER])
    expect(plan.feePayer.equals(BUYER)).toBe(true)
    expect(keyAt(accept, 2).equals(offerPda(fixture.mint, SELLER, OFFER_ID))).toBe(true)
    expect(keyAt(accept, 3).equals(SELLER)).toBe(true)
    expect(keyAt(accept, 4).equals(tokenConfigPda(fixture.mint))).toBe(true)
    expect(keyAt(accept, 11).equals(FEE_TREASURY)).toBe(true)
    expect(expectPdasAsDeclared(accept, 'acceptOffer')).toEqual([
      'platform',
      'sellerTokenAccount',
      'buyerTokenAccount',
      'sellerPaymentAccount',
    ])
  })

  it('carries the hook tail for seller → buyer: the list the program wrote for this pair', async () => {
    const { accept } = split((await buildAcceptOffer(program, args)).instructions)
    expect(keyAt(accept, 6).equals(fixture.source)).toBe(true)
    expect(keyAt(accept, 7).equals(fixture.destination)).toBe(true)
    expect(keyAt(accept, 12).equals(fixture.extraAccountMetaList)).toBe(true)
    expect(keyAt(accept, 13).equals(PROGRAM_ID)).toBe(true)
    // Admission is the buyer's, the grant and the permit are the seller's.
    expect(keyAt(accept, 14).equals(fixture.investorRecord)).toBe(true)
    expect(keyAt(accept, 15).equals(fixture.grant)).toBe(true)
    expect(keyAt(accept, 16).equals(fixture.transferPermit)).toBe(true)
    expect(keyAt(accept, 17).equals(HOOK_PROGRAM_ID)).toBe(true)
  })

  it('a classic-program stablecoin moves on its own program; the shares stay on Token-2022', async () => {
    const platform = { ...args.platform, paymentTokenProgram: TOKEN_PROGRAM_ID }
    const { accept } = split((await buildAcceptOffer(program, { ...args, platform })).instructions)
    expect(keyAt(accept, 18).equals(TOKEN_2022_PROGRAM_ID)).toBe(true)
    expect(keyAt(accept, 19).equals(TOKEN_PROGRAM_ID)).toBe(true)
    const classicAta = (owner: PublicKey) =>
      getAssociatedTokenAddressSync(PAYMENT_MINT, owner, true, TOKEN_PROGRAM_ID)
    expect(keyAt(accept, 9).equals(classicAta(BUYER))).toBe(true)
    expect(keyAt(accept, 10).equals(classicAta(SELLER))).toBe(true)
    expect(expectPdasAsDeclared(accept, 'acceptOffer')).toContain('sellerPaymentAccount')
  })

  it('pays from the buyer’s ATA by default, or from the account the buyer names', async () => {
    const own = PublicKey.unique()
    const { accept } = split(
      (await buildAcceptOffer(program, { ...args, buyerPaymentAccount: own })).instructions,
    )
    expect(keyAt(accept, 9).equals(own)).toBe(true)
  })

  it('a partial fill takes 1..=remaining; anything else is refused before signing', async () => {
    for (const amount of [0n, -1n, 601n]) {
      await expect(buildAcceptOffer(program, { ...args, amount })).rejects.toThrow(RangeError)
    }
    const whole = await buildAcceptOffer(program, { ...args, amount: 600n })
    expect(whole.quote.amount).toBe(600n)
  })

  it('the plan carries the quote of exactly its amount', async () => {
    const plan = await buildAcceptOffer(program, args)
    expect(plan.quote).toEqual({
      amount: 150n,
      payment: 37_500_000n,
      fee: 937_500n,
      sellerReceives: 36_562_500n,
    })
    expect(plan.quote).toEqual(quoteOffer(250, 250_000n, 150n))
  })

  it('fits the transaction budget with the compute limit — 22 accounts, no lookup table', async () => {
    const transaction = compileTransaction(await buildAcceptOffer(program, args), BLOCKHASH)
    expect(transaction.version).toBe(0)
    expect(transactionBytes(transaction)).toBeLessThanOrEqual(MAX_TRANSACTION_BYTES)
  })
})

describe('quoteOffer', () => {
  it('is the program’s arithmetic: a product for the payment, the fee rounded down', () => {
    // `market_state.rs`: 100 bps of 1 000 000 is 10 000; of 99 it is nothing.
    expect(quoteOffer(100, 1_000_000n, 1n)).toEqual({
      amount: 1n,
      payment: 1_000_000n,
      fee: 10_000n,
      sellerReceives: 990_000n,
    })
    expect(quoteOffer(100, 99n, 1n).fee).toBe(0n)
    expect(quoteOffer(0, 1n, U64_MAX)).toEqual({
      amount: U64_MAX,
      payment: U64_MAX,
      fee: 0n,
      sellerReceives: U64_MAX,
    })
    expect(() => quoteOffer(100, 2n, U64_MAX)).toThrow(RangeError)
    expect(() => quoteOffer(1_001, 1n, 1n)).toThrow(RangeError)
  })

  it('partial fills add up to the whole payment, and never to more fee than the whole', () => {
    const fills = [150n, 150n, 299n, 1n]
    const quotes = fills.map((amount) => quoteOffer(250, 333_333n, amount))
    const whole = quoteOffer(250, 333_333n, 600n)
    const sum = (pick: (q: (typeof quotes)[number]) => bigint) =>
      quotes.map(pick).reduce((a, b) => a + b, 0n)
    expect(sum((q) => q.payment)).toBe(whole.payment)
    expect(sum((q) => q.fee)).toBeLessThanOrEqual(whole.fee)
    for (const q of quotes) {
      expect(q.fee + q.sellerReceives).toBe(q.payment)
      expect(q.fee).toBe(platformFee(250, q.payment))
    }
  })
})
