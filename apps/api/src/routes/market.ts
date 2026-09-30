import { type MarketOffers, marketOffersQuerySchema } from '@caprail/shared'
import { Hono } from 'hono'
import type { AppEnv } from '../env.ts'
import type { IndexReader } from '../index/reader.ts'
import { validate } from '../middleware/validate.ts'
import { type PlatformSource, withQuote } from '../platform.ts'

export type MarketDeps = {
  reader: Pick<IndexReader, 'marketOffers'>
  platform: PlatformSource
  now?: () => Date
}

// The storefront (FR-011): open offers of other holders that the hook would let reach
// this wallet right now. The scope is the wallet alone — no company opens its whole
// book here — and the filter is the index's mirror of the hook; the hook still decides
// at transfer time (FR-012), so a record revoked a second ago costs a refused
// transaction, not a leak. Any signed-in wallet may ask: a policy without
// accreditation admits wallets that are in no registry.
export function marketRoute(deps: MarketDeps): Hono<AppEnv> {
  const now = deps.now ?? (() => new Date())

  return new Hono<AppEnv>().get(
    '/market/offers',
    validate('query', marketOffersQuerySchema),
    async (c) => {
      const { wallet } = c.get('session')
      const [offers, platform] = await Promise.all([
        deps.reader.marketOffers({ wallet }, wallet, c.req.valid('query'), now()),
        deps.platform(),
      ])
      const body: MarketOffers = {
        platform,
        offers: offers.map((offer) => withQuote(offer, platform)),
      }
      return c.json(body)
    },
  )
}
