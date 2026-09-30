import { type CaprailProgram, platformFee, platformPda } from '@caprail/chain'
import type { OfferQuote, OfferRecord, OfferView, PlatformView } from '@caprail/shared'

// The platform's configuration as the routes need it: null until `init_platform` has
// run on this deployment.
export type PlatformSource = () => Promise<PlatformView | null>

// `PlatformConfig` is read from the chain, not indexed: `init_platform` runs once and
// there is no instruction that changes it, so the account itself is the truth and a
// read that found it never goes stale. Only a found config is kept — a missing one may
// be initialised a minute later — and a failed read is not remembered either; callers
// that arrive while a read is in flight share it.
export function cachedPlatform(read: PlatformSource): PlatformSource {
  let found: PlatformView | null = null
  let inFlight: Promise<PlatformView | null> | null = null
  return () => {
    if (found !== null) return Promise.resolve(found)
    inFlight ??= read()
      .then((platform) => {
        found = platform
        return platform
      })
      .finally(() => {
        inFlight = null
      })
    return inFlight
  }
}

export function chainPlatform(program: CaprailProgram): PlatformSource {
  return cachedPlatform(async () => {
    const account = await program.account.platformConfig.fetchNullable(platformPda())
    if (account === null) return null
    return {
      feeBps: account.feeBps,
      paymentMint: account.paymentMint.toBase58(),
      feeTreasury: account.feeTreasury.toBase58(),
    }
  })
}

// The price of the whole `remaining` with the program's fee formula. No quote for a
// closed offer, without a platform, or for an offer priced in another mint than the
// platform's — that would be an index of another deployment, and a fee computed from
// the wrong config is worse than none.
export function quoteOf(offer: OfferRecord, platform: PlatformView | null): OfferQuote | null {
  if (platform === null || offer.status !== 'open' || offer.paymentMint !== platform.paymentMint) {
    return null
  }
  const amount = BigInt(offer.remaining)
  const payment = amount * BigInt(offer.pricePerUnit)
  const fee = platformFee(platform.feeBps, payment)
  return {
    amount: amount.toString(),
    payment: payment.toString(),
    fee: fee.toString(),
    sellerReceives: (payment - fee).toString(),
  }
}

export function withQuote<T extends OfferRecord>(
  offer: T,
  platform: PlatformView | null,
): T & Pick<OfferView, 'quote'> {
  return { ...offer, quote: quoteOf(offer, platform) }
}
