import { type MarketOffers, type Me, marketOffersSchema, meSchema } from '@caprail/shared'
import { type UseQueryResult, useQuery } from '@tanstack/react-query'
import { useRefreshQueries } from '../chain/hooks.ts'
import { useApi } from '../providers.tsx'

// The investor's reads (FR-011, FR-016), scoped to the session's wallet by the API.
// There is no event stream for them: the market moves by other people's transactions
// slowly enough that a refetch on focus of the page and after the wallet's own
// transaction is the honest cost.

export const investorKeys = {
  me: ['me'] as const,
  market: ['market'] as const,
}

export function useMe(): UseQueryResult<Me, Error> {
  const api = useApi()
  return useQuery({
    queryKey: investorKeys.me,
    queryFn: () => api.request('GET', '/me', meSchema),
  })
}

export function useMarketOffers(): UseQueryResult<MarketOffers, Error> {
  const api = useApi()
  return useQuery({
    queryKey: investorKeys.market,
    queryFn: () => api.request('GET', '/market/offers', marketOffersSchema),
  })
}

const INVESTOR_READS = [investorKeys.me, investorKeys.market]

/** After a trade both sides' views move: the cabinet and the storefront. */
export function useRefreshInvestor(): () => void {
  return useRefreshQueries(INVESTOR_READS)
}
