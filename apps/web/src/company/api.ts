import {
  type AttemptReport,
  type AttemptReportResponse,
  attemptReportResponseSchema,
  type CapTable,
  type CompanyView,
  capTableSchema,
  companyViewSchema,
  type InvestorView,
  investorViewSchema,
  type JournalPage,
  journalPageSchema,
} from '@caprail/shared'
import {
  type InfiniteData,
  type UseInfiniteQueryResult,
  type UseQueryResult,
  useInfiniteQuery,
  useQuery,
} from '@tanstack/react-query'
import { z } from 'zod'
import { type ApiClient, ApiError } from '../api/client.ts'
import { useApi } from '../providers.tsx'

// Reads of the panel, parsed with the same schemas the API serialises with.
// Keys start with ['company', id] so one invalidation after a transaction covers
// every read of that company; `companyKeys` names the parts the feed patches.

export const companyKeys = {
  all: (companyId: string) => ['company', companyId] as const,
  view: (companyId: string) => ['company', companyId, 'view'] as const,
  investors: (companyId: string) => ['company', companyId, 'investors'] as const,
  capTable: (companyId: string, mint: string) => ['company', companyId, 'cap-table', mint] as const,
  journal: (companyId: string) => ['company', companyId, 'journal'] as const,
}

// FORBIDDEN or NOT_FOUND on a company this key holds a role in means the index has
// not caught up with the chain (a company created seconds ago); keep asking.
export const CATCH_UP_INTERVAL_MS = 2_000

export function isCatchingUp(error: unknown): boolean {
  return error instanceof ApiError && (error.code === 'FORBIDDEN' || error.code === 'NOT_FOUND')
}

export function useCompany(companyId: string): UseQueryResult<CompanyView, Error> {
  const api = useApi()
  return useQuery({
    queryKey: companyKeys.view(companyId),
    queryFn: () => api.request('GET', `/companies/${companyId}`, companyViewSchema),
    refetchInterval: (query) => (isCatchingUp(query.state.error) ? CATCH_UP_INTERVAL_MS : false),
  })
}

export function useInvestors(companyId: string): UseQueryResult<InvestorView[], Error> {
  const api = useApi()
  return useQuery({
    queryKey: companyKeys.investors(companyId),
    queryFn: () =>
      api.request('GET', `/companies/${companyId}/investors`, z.array(investorViewSchema)),
    refetchInterval: (query) => (isCatchingUp(query.state.error) ? CATCH_UP_INTERVAL_MS : false),
  })
}

export function useCapTable(companyId: string, mint: string): UseQueryResult<CapTable, Error> {
  const api = useApi()
  return useQuery({
    queryKey: companyKeys.capTable(companyId, mint),
    queryFn: () =>
      api.request(
        'GET',
        `/companies/${companyId}/cap-table?${new URLSearchParams({ mint })}`,
        capTableSchema,
      ),
  })
}

export type JournalPages = InfiniteData<JournalPage, string | null>

// Newest first; each page hands back the cursor of the next (older) one. The feed
// prepends new entries to the first page, so the pages are never refetched by it.
export function useJournal(companyId: string): UseInfiniteQueryResult<JournalPages, Error> {
  const api = useApi()
  return useInfiniteQuery({
    queryKey: companyKeys.journal(companyId),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      api.request(
        'GET',
        `/companies/${companyId}/journal${pageParam === null ? '' : `?${new URLSearchParams({ cursor: pageParam })}`}`,
        journalPageSchema,
      ),
    getNextPageParam: (page) => page.nextCursor,
  })
}

// A refusal our simulation caught before the wallet signed (nothing reached the
// chain): reported so the journal shows it as `simulation`.
export function reportAttempt(
  api: ApiClient,
  report: AttemptReport,
): Promise<AttemptReportResponse> {
  return api.request('POST', '/attempts', attemptReportResponseSchema, report)
}
