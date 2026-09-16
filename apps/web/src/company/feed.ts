import {
  type CompanyView,
  type FeedEvent,
  feedEventSchema,
  type InvestorView,
  type JournalEntry,
} from '@caprail/shared'
import { type QueryClient, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import type { SseFrame, StreamStatus } from '../api/sse.ts'
import { useApi } from '../providers.tsx'
import { companyKeys, type JournalPages } from './api.ts'

// The panel's live feed (SC-003, SC-004): SSE `/companies/:id/events` patches the
// query cache in place — the journal entry, the investor row and the policy come
// whole in the event, the cap table is refetched because holdings do not. The
// stream starts at the moment of connection, so every (re)connection also
// invalidates the company's reads to cover what a gap may have missed.

export type FeedState = StreamStatus | { kind: 'idle' }

// Newest first; an entry the page already has (a refetch raced the feed) is not
// added twice. Nothing loaded yet → nothing to patch, the query will fetch it.
export function prependEntry(
  pages: JournalPages | undefined,
  entry: JournalEntry,
): JournalPages | undefined {
  if (pages === undefined) return undefined
  if (pages.pages.some((page) => page.items.some((item) => item.id === entry.id))) return pages
  const [first, ...rest] = pages.pages
  if (first === undefined) return pages
  return { ...pages, pages: [{ ...first, items: [entry, ...first.items] }, ...rest] }
}

export function upsertInvestor(
  investors: InvestorView[] | undefined,
  investor: InvestorView,
): InvestorView[] | undefined {
  if (investors === undefined) return undefined
  const index = investors.findIndex(
    (row) => row.mint === investor.mint && row.wallet === investor.wallet,
  )
  if (index < 0) return [...investors, investor]
  const current = investors[index]
  // Events replay in order, but a refetch may already be ahead of the stream.
  if (current !== undefined && Date.parse(current.updatedAt) > Date.parse(investor.updatedAt)) {
    return investors
  }
  return investors.map((row, i) => (i === index ? investor : row))
}

export function applyPolicy(
  view: CompanyView | undefined,
  event: Extract<FeedEvent, { kind: 'policy' }>,
): CompanyView | undefined {
  if (view === undefined) return undefined
  return {
    ...view,
    tokens: view.tokens.map((token) =>
      token.mint === event.mint && token.policyVersion < event.policyVersion
        ? { ...token, policy: event.policy, policyVersion: event.policyVersion }
        : token,
    ),
  }
}

export function applyFeedEvent(queryClient: QueryClient, companyId: string, event: FeedEvent) {
  switch (event.kind) {
    case 'attempt':
      queryClient.setQueryData<JournalPages>(companyKeys.journal(companyId), (pages) =>
        prependEntry(pages, event.entry),
      )
      if (event.entry.outcome === 'allowed') {
        void queryClient.invalidateQueries({
          queryKey: companyKeys.capTable(companyId, event.entry.mint),
        })
      }
      return
    case 'status':
      queryClient.setQueryData<InvestorView[]>(companyKeys.investors(companyId), (investors) =>
        upsertInvestor(investors, event.investor),
      )
      return
    case 'policy':
      queryClient.setQueryData<CompanyView>(companyKeys.view(companyId), (view) =>
        applyPolicy(view, event),
      )
      return
  }
}

// `ready` and `ping` carry no record; anything else must parse as a `FeedEvent`.
export function parseFeedFrame(frame: SseFrame): FeedEvent | null {
  if (frame.event === 'ready' || frame.event === 'ping') return null
  try {
    const parsed = feedEventSchema.safeParse(JSON.parse(frame.data))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

export function useCompanyFeed(companyId: string): FeedState {
  const api = useApi()
  const queryClient = useQueryClient()
  const [state, setState] = useState<FeedState>({ kind: 'idle' })

  useEffect(() => {
    const stream = api.stream(`/companies/${companyId}/events`, {
      onStatus: (status) => {
        setState(status)
        // Also on the first open: the page's reads may have answered before the
        // server subscribed this connection to the poller.
        if (status.kind === 'open') {
          void queryClient.invalidateQueries({ queryKey: companyKeys.all(companyId) })
        }
      },
      onFrame: (frame) => {
        const event = parseFeedFrame(frame)
        if (event !== null) applyFeedEvent(queryClient, companyId, event)
      },
    })
    return () => stream.stop()
  }, [api, queryClient, companyId])

  return state
}
