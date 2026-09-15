import {
  type CompanyView,
  companyViewSchema,
  type InvestorView,
  investorViewSchema,
} from '@caprail/shared'
import { type UseQueryResult, useQuery } from '@tanstack/react-query'
import { z } from 'zod'
import { ApiError } from '../api/client.ts'
import { useApi } from '../providers.tsx'

// Reads of the panel, parsed with the same schemas the API serialises with.
// Keys start with ['company', id] so one invalidation after a transaction covers
// every read of that company.

// FORBIDDEN or NOT_FOUND on a company this key holds a role in means the index has
// not caught up with the chain (a company created seconds ago); keep asking.
export const CATCH_UP_INTERVAL_MS = 2_000

export function isCatchingUp(error: unknown): boolean {
  return error instanceof ApiError && (error.code === 'FORBIDDEN' || error.code === 'NOT_FOUND')
}

export function useCompany(companyId: string): UseQueryResult<CompanyView, Error> {
  const api = useApi()
  return useQuery({
    queryKey: ['company', companyId, 'view'],
    queryFn: () => api.request('GET', `/companies/${companyId}`, companyViewSchema),
    refetchInterval: (query) => (isCatchingUp(query.state.error) ? CATCH_UP_INTERVAL_MS : false),
  })
}

export function useInvestors(companyId: string): UseQueryResult<InvestorView[], Error> {
  const api = useApi()
  return useQuery({
    queryKey: ['company', companyId, 'investors'],
    queryFn: () =>
      api.request('GET', `/companies/${companyId}/investors`, z.array(investorViewSchema)),
    refetchInterval: (query) => (isCatchingUp(query.state.error) ? CATCH_UP_INTERVAL_MS : false),
  })
}
