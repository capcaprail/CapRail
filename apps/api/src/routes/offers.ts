import { type CompanyOffers, companyOffersQuerySchema } from '@caprail/shared'
import { Hono } from 'hono'
import type { AppEnv } from '../env.ts'
import type { IndexReader } from '../index/reader.ts'
import { validate } from '../middleware/validate.ts'
import { type PlatformSource, withQuote } from '../platform.ts'
import { panelScope } from './companies.ts'

export type OffersDeps = {
  reader: Pick<IndexReader, 'companyOffers'>
  platform: PlatformSource
}

// The company's book across its mints (panel, T043): every status, with the worker's
// reading of each open offer and what taking all of it costs. Mounted behind the same
// session + panel-role middleware as the rest of `/companies/:id/*`.
export function offersRoute(deps: OffersDeps): Hono<AppEnv> {
  return new Hono<AppEnv>().get(
    '/companies/:id/offers',
    validate('query', companyOffersQuerySchema),
    async (c) => {
      const id = c.req.param('id')
      const [offers, platform] = await Promise.all([
        deps.reader.companyOffers(
          panelScope(id, c.get('session').wallet),
          id,
          c.req.valid('query'),
        ),
        deps.platform(),
      ])
      const body: CompanyOffers = {
        platform,
        offers: offers.map((offer) => withQuote(offer, platform)),
      }
      return c.json(body)
    },
  )
}
