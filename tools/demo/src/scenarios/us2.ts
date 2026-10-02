// The US2 story, as the M2 demo tells it (TASKS.md → M2 "what we show"): a holder
// offers shares, an admitted buyer takes part of them — shares, payment and fee in one
// transaction — a buyer who lost admission is refused before any balance moves, the
// seller cancels the rest, and a second offer is filled whole.
//
// It runs on top of the US1 story (company, token, two admitted investors holding
// shares) and needs the platform configured by `init-platform` with the demo
// stablecoin: `--authority` is that key, the stablecoin's mint authority, so the run
// can pay its buyers. Every trade goes through the same builder the panel uses, and
// the fee the builder quoted is checked against the fee the chain charged (FR-013).
import {
  ACCEPT_OFFER_COMPUTE_UNITS,
  type AcceptOfferPlan,
  ata,
  buildAcceptOffer,
  buildCancelOffer,
  buildCreateOffer,
  fetchPlatform,
  type OfferQuoteAmounts,
  offerPda,
  type PlatformState,
  TOKEN_2022_PROGRAM_ID,
} from '@caprail/chain'
import { type OfferAccepted, parseTransaction } from '@caprail/indexer'
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createMintToInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  getMint,
} from '@solana/spl-token'
import type { Keypair, PublicKey } from '@solana/web3.js'
import { chainTime, type DemoContext, fund, loadKeypair } from '../context.ts'
import { expectRefusal, type Refused, type Sent, submit, submitPlan } from '../send.ts'
import { type Log, setStatus, type Token, tokenBalance, type Us1Result } from './us1.ts'

/** What the run sends, by name — `--dump` writes them as the indexer's fixtures. */
export type Us2Transactions = {
  readonly createOffer: Sent
  readonly acceptPartial: Sent
  /** The buyer loses admission between the offer and the attempt. */
  readonly revokeBuyer: Sent
  readonly acceptRefused: Refused
  readonly cancelOffer: Sent
  /** The second offer, taken whole. */
  readonly createSecond: Sent
  readonly acceptFilled: Sent
}

/** One trade: the quote the panel would have shown, and what the chain did. */
export type Trade = {
  readonly quote: OfferQuoteAmounts
  readonly event: OfferAccepted
  /** Balance changes of the four accounts the trade touches. */
  readonly deltas: {
    readonly buyerPayment: bigint
    readonly sellerPayment: bigint
    readonly feeTreasury: bigint
    readonly sellerShares: bigint
    readonly buyerShares: bigint
  }
  readonly computeUnits: number | undefined
}

export type Us2Result = {
  readonly platform: PlatformState
  readonly partial: Trade
  readonly filled: Trade
  /** The refused buyer's attempt: nothing moved, the hook named the reason. */
  readonly refusal: { readonly reason: string | undefined; readonly unchanged: boolean }
  /** After `cancel_offer`: the offer is cancelled and the seller's account free again. */
  readonly cancel: { readonly remaining: bigint; readonly delegationCleared: boolean }
  readonly transactions: Us2Transactions
}

// Prices are per share in whole stablecoins; the token has no decimals (`DECIMALS`).
const OFFER = { amount: 600n, pricePerShare: 1_250_000n } as const
const PARTIAL = 150n
const REFUSED = 50n
const SECOND = { amount: 10n, pricePerShare: 2_000_000n } as const
/** Whole stablecoins each buyer is paid, in the mint's own decimals. */
const BUYER_FUNDS = 10_000n

const ONE_YEAR = 365n * 24n * 3600n

function randomU64(): bigint {
  const bytes = new Uint8Array(8)
  crypto.getRandomValues(bytes)
  return new DataView(bytes.buffer).getBigUint64(0, true)
}

/** The platform as the panel reads it, and the proof this run can pay its buyers. */
export async function readPlatform(ctx: DemoContext, authority: Keypair): Promise<PlatformState> {
  const platform = await fetchPlatform(ctx.program)
  if (platform === null) {
    throw new Error('the platform is not configured — run `pnpm demo:init-platform` first')
  }
  const mint = await getMint(
    ctx.connection,
    platform.paymentMint,
    'confirmed',
    platform.paymentTokenProgram,
  )
  if (mint.mintAuthority === null || !mint.mintAuthority.equals(authority.publicKey)) {
    throw new Error(
      `--authority is not the mint authority of ${platform.paymentMint.toBase58()} — ` +
        'this demo pays its buyers in the demo stablecoin it issued',
    )
  }
  return platform
}

const paymentAta = (platform: PlatformState, owner: PublicKey): PublicKey =>
  getAssociatedTokenAddressSync(platform.paymentMint, owner, true, platform.paymentTokenProgram)

async function paymentBalance(
  ctx: DemoContext,
  platform: PlatformState,
  account: PublicKey,
): Promise<bigint> {
  try {
    const state = await getAccount(
      ctx.connection,
      account,
      'confirmed',
      platform.paymentTokenProgram,
    )
    return state.amount
  } catch {
    // Not created yet: `accept_offer` creates the seller's on first sale.
    return 0n
  }
}

async function payBuyer(
  ctx: DemoContext,
  platform: PlatformState,
  authority: Keypair,
  buyer: PublicKey,
): Promise<void> {
  const account = paymentAta(platform, buyer)
  const { decimals } = await getMint(
    ctx.connection,
    platform.paymentMint,
    'confirmed',
    platform.paymentTokenProgram,
  )
  await submit(
    ctx.connection,
    authority.publicKey,
    [
      createAssociatedTokenAccountIdempotentInstruction(
        authority.publicKey,
        account,
        buyer,
        platform.paymentMint,
        platform.paymentTokenProgram,
      ),
      createMintToInstruction(
        platform.paymentMint,
        account,
        authority.publicKey,
        BUYER_FUNDS * 10n ** BigInt(decimals),
        [],
        platform.paymentTokenProgram,
      ),
    ],
    [authority],
  )
}

type Offer = {
  readonly seller: Keypair
  readonly offerId: bigint
  readonly pricePerUnit: bigint
}

async function createOffer(
  ctx: DemoContext,
  token: Token,
  seller: Keypair,
  amount: bigint,
  pricePerUnit: bigint,
): Promise<{ offer: Offer; sent: Sent }> {
  const offerId = randomU64()
  const sent = await submitPlan(
    ctx.connection,
    await buildCreateOffer(ctx.program, {
      seller: seller.publicKey,
      mint: token.mint,
      offerId,
      amount,
      pricePerUnit,
    }),
    [seller],
  )
  return { offer: { seller, offerId, pricePerUnit }, sent }
}

async function acceptPlan(
  ctx: DemoContext,
  token: Token,
  platform: PlatformState,
  offer: Offer,
  buyer: PublicKey,
  amount: bigint,
): Promise<AcceptOfferPlan> {
  // `remaining` as the chain has it now — what the index would serve the panel.
  const state = await ctx.program.account.offer.fetch(
    offerPda(token.mint, offer.seller.publicKey, offer.offerId),
  )
  return await buildAcceptOffer(ctx.program, {
    buyer,
    offer: {
      mint: token.mint,
      seller: offer.seller.publicKey,
      offerId: offer.offerId,
      pricePerUnit: offer.pricePerUnit,
      remaining: BigInt(state.remaining.toString()),
    },
    platform,
    amount,
  })
}

type Balances = {
  buyerPayment: bigint
  sellerPayment: bigint
  feeTreasury: bigint
  sellerShares: bigint
  buyerShares: bigint
}

async function balances(
  ctx: DemoContext,
  token: Token,
  platform: PlatformState,
  seller: PublicKey,
  buyer: PublicKey,
): Promise<Balances> {
  const shares = async (owner: PublicKey): Promise<bigint> =>
    (await ctx.connection.getAccountInfo(ata(owner, token.mint), 'confirmed')) === null
      ? 0n
      : await tokenBalance(ctx, token, owner)
  return {
    buyerPayment: await paymentBalance(ctx, platform, paymentAta(platform, buyer)),
    sellerPayment: await paymentBalance(ctx, platform, paymentAta(platform, seller)),
    feeTreasury: await paymentBalance(ctx, platform, platform.feeTreasury),
    sellerShares: await shares(seller),
    buyerShares: await shares(buyer),
  }
}

const sameBalances = (a: Balances, b: Balances): boolean =>
  (Object.keys(a) as (keyof Balances)[]).every((key) => a[key] === b[key])

function acceptedEvent(sent: Sent): OfferAccepted {
  const parsed = parseTransaction(sent.transaction)
  const event = parsed.events.find((e) => e.kind === 'OfferAccepted')
  if (event?.kind !== 'OfferAccepted') {
    throw new Error(`no OfferAccepted in ${sent.signature}`)
  }
  return event
}

async function trade(
  ctx: DemoContext,
  token: Token,
  platform: PlatformState,
  offer: Offer,
  buyer: Keypair,
  amount: bigint,
): Promise<{ trade: Trade; sent: Sent }> {
  const plan = await acceptPlan(ctx, token, platform, offer, buyer.publicKey, amount)
  const before = await balances(ctx, token, platform, offer.seller.publicKey, buyer.publicKey)
  const sent = await submitPlan(ctx.connection, plan, [buyer])
  const after = await balances(ctx, token, platform, offer.seller.publicKey, buyer.publicKey)
  return {
    sent,
    trade: {
      quote: plan.quote,
      event: acceptedEvent(sent),
      deltas: {
        buyerPayment: after.buyerPayment - before.buyerPayment,
        sellerPayment: after.sellerPayment - before.sellerPayment,
        feeTreasury: after.feeTreasury - before.feeTreasury,
        sellerShares: after.sellerShares - before.sellerShares,
        buyerShares: after.buyerShares - before.buyerShares,
      },
      computeUnits: sent.computeUnits,
    },
  }
}

/**
 * The quote is exactly what the chain did: the event carries the same payment and fee,
 * and the four balances moved by exactly those amounts — nothing else, in one transaction.
 */
export function tradeMatchesQuote(t: Trade): boolean {
  const { quote, event, deltas } = t
  return (
    event.amount === quote.amount &&
    event.payment === quote.payment &&
    event.fee === quote.fee &&
    deltas.buyerPayment === -quote.payment &&
    deltas.sellerPayment === quote.sellerReceives &&
    deltas.feeTreasury === quote.fee &&
    deltas.sellerShares === -quote.amount &&
    deltas.buyerShares === quote.amount
  )
}

export async function runUs2(
  ctx: DemoContext,
  us1: Us1Result,
  authorityPath: string,
  payer: Keypair | undefined,
  log: Log,
): Promise<Us2Result> {
  const { keys, connection } = ctx
  const { token } = us1
  const authority = loadKeypair(authorityPath)
  const platform = await readPlatform(ctx, authority)
  log(
    `platform: fee ${platform.feeBps} bps, payment mint ${platform.paymentMint.toBase58()} ` +
      `(${platform.paymentDecimals} decimals)`,
  )

  // Bob buys; `revoked` is admitted and paid, then loses admission before accepting.
  await fund(connection, keys.revoked.publicKey, ctx.local ? 0.5 : 0.05, payer)
  const expiresAt = BigInt(await chainTime(connection)) + ONE_YEAR
  await setStatus(ctx, token, keys.revoked.publicKey, 'approved', expiresAt)
  for (const buyer of [keys.bob, keys.revoked]) {
    await payBuyer(ctx, platform, authority, buyer.publicKey)
  }
  log(`  paid ${BUYER_FUNDS} demo stablecoins to bob and to a buyer about to be revoked`)

  const created = await createOffer(ctx, token, keys.alice, OFFER.amount, OFFER.pricePerShare)
  log(
    `  create_offer   ${created.sent.signature} — alice offers ${OFFER.amount} at ${OFFER.pricePerShare} base units`,
  )

  const partial = await trade(ctx, token, platform, created.offer, keys.bob, PARTIAL)
  log(
    `  accept_offer   ${partial.sent.signature} — bob takes ${PARTIAL}: pays ${partial.trade.quote.payment}, ` +
      `fee ${partial.trade.quote.fee}, ${partial.trade.computeUnits ?? '?'} CU`,
  )

  const revokeBuyer = await setStatus(ctx, token, keys.revoked.publicKey, 'revoked', expiresAt)
  const plan = await acceptPlan(
    ctx,
    token,
    platform,
    created.offer,
    keys.revoked.publicKey,
    REFUSED,
  )
  const before = await balances(ctx, token, platform, keys.alice.publicKey, keys.revoked.publicKey)
  const acceptRefused = await expectRefusal(connection, plan, [keys.revoked])
  const after = await balances(ctx, token, platform, keys.alice.publicKey, keys.revoked.publicKey)
  const offerAfterRefusal = await ctx.program.account.offer.fetch(
    offerPda(token.mint, keys.alice.publicKey, created.offer.offerId),
  )
  const unchanged =
    sameBalances(before, after) &&
    BigInt(offerAfterRefusal.remaining.toString()) === OFFER.amount - PARTIAL
  log(
    `  accept_offer by a revoked buyer, skipPreflight: refused on chain — ${acceptRefused.reason} ` +
      `${acceptRefused.signature}; balances unchanged: ${unchanged}`,
  )

  const cancelOffer = await submitPlan(
    connection,
    await buildCancelOffer(ctx.program, {
      seller: keys.alice.publicKey,
      mint: token.mint,
      offerId: created.offer.offerId,
    }),
    [keys.alice],
  )
  const cancelled = await ctx.program.account.offer.fetch(
    offerPda(token.mint, keys.alice.publicKey, created.offer.offerId),
  )
  const aliceAccount = await getAccount(
    connection,
    ata(keys.alice.publicKey, token.mint),
    'confirmed',
    TOKEN_2022_PROGRAM_ID,
  )
  const cancel = {
    remaining: BigInt(cancelled.remaining.toString()),
    delegationCleared: aliceAccount.delegate === null && aliceAccount.delegatedAmount === 0n,
  }
  log(
    `  cancel_offer   ${cancelOffer.signature} — ${cancel.remaining} left unsold, delegation cleared: ${cancel.delegationCleared}`,
  )

  const second = await createOffer(ctx, token, keys.bob, SECOND.amount, SECOND.pricePerShare)
  const filled = await trade(ctx, token, platform, second.offer, keys.alice, SECOND.amount)
  log(
    `  accept_offer   ${filled.sent.signature} — alice takes bob's ${SECOND.amount} whole: offer filled, ` +
      `${filled.trade.computeUnits ?? '?'} CU of ${ACCEPT_OFFER_COMPUTE_UNITS}`,
  )

  return {
    platform,
    partial: partial.trade,
    filled: filled.trade,
    refusal: { reason: acceptRefused.reason, unchanged },
    cancel,
    transactions: {
      createOffer: created.sent,
      acceptPartial: partial.sent,
      revokeBuyer,
      acceptRefused,
      cancelOffer,
      createSecond: second.sent,
      acceptFilled: filled.sent,
    },
  }
}
