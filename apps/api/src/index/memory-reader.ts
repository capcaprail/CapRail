import type { TenantScope } from '@caprail/db'
import type {
  CapTable,
  CompanyView,
  FeedEvent,
  InvestorView,
  JournalEntry,
  Membership,
  Role,
  WalletAddress,
} from '@caprail/shared'
import {
  decodeCursor,
  encodeCursor,
  type FeedMarks,
  type IndexReader,
  percentOf,
  policyKey,
} from './reader.ts'

export type MemoryHolding = {
  mint: string
  wallet: string
  amount: bigint
  distributed: bigint
}

export type MemoryPolicyVersion = {
  mint: string
  version: number
  slot: bigint
  policy: CompanyView['tokens'][number]['policy']
  setAt: string | null
}

export type MemoryStatusEvent = { id: bigint; investor: InvestorView }

// Rows the way the routes see them, plus what RLS would use to scope them. Test
// double of `drizzleIndexReader`: the same contract over arrays, with visibility
// decided the way the policies do — a company scope opens its rows, a wallet sees
// the companies it has a role or a registry entry in.
export type MemoryIndex = {
  companies: CompanyView[]
  investors: InvestorView[]
  holdings: MemoryHolding[]
  attempts: (JournalEntry & { companyId: string; reportedBy: string | null })[]
  statusEvents: (MemoryStatusEvent & { companyId: string })[]
  policyVersions: (MemoryPolicyVersion & { companyId: string })[]
}

export function memoryIndex(seed: Partial<MemoryIndex> = {}): MemoryIndex {
  return {
    companies: [],
    investors: [],
    holdings: [],
    attempts: [],
    statusEvents: [],
    policyVersions: [],
    ...seed,
  }
}

function rolesIn(index: MemoryIndex, company: CompanyView, wallet: string): Role[] {
  const roles: Role[] = []
  if (company.admin === wallet) roles.push('admin')
  if (company.complianceOfficer === wallet) roles.push('compliance_officer')
  if (
    index.investors.some(
      (i) => i.wallet === wallet && company.tokens.some((t) => t.mint === i.mint),
    )
  ) {
    roles.push('investor')
  }
  return roles
}

function visible(index: MemoryIndex, scope: TenantScope, companyId: string): boolean {
  if (scope.companyId === companyId) return true
  const company = index.companies.find((c) => c.companyId === companyId)
  return (
    company !== undefined &&
    scope.wallet !== undefined &&
    rolesIn(index, company, scope.wallet).length > 0
  )
}

export function memoryIndexReader(index: MemoryIndex): IndexReader {
  const companyOf = (mint: string) =>
    index.companies.find((c) => c.tokens.some((t) => t.mint === mint))
  let nextAttemptId = 1n + BigInt(index.attempts.length)

  const membershipsOf = (wallet: WalletAddress): Promise<Membership[]> =>
    Promise.resolve(
      index.companies.flatMap((company) =>
        rolesIn(index, company, wallet).map((role) => ({ companyId: company.companyId, role })),
      ),
    )

  return {
    membershipsOf,
    rolesOf: async (companyId, wallet) =>
      (await membershipsOf(wallet)).filter((m) => m.companyId === companyId).map((m) => m.role),

    company: (scope, companyId) =>
      Promise.resolve(
        visible(index, scope, companyId)
          ? (index.companies.find((c) => c.companyId === companyId) ?? null)
          : null,
      ),

    investors: (scope, companyId) => {
      if (!visible(index, scope, companyId)) return Promise.resolve([])
      const mints = new Set(
        index.companies.find((c) => c.companyId === companyId)?.tokens.map((t) => t.mint),
      )
      return Promise.resolve(index.investors.filter((i) => mints.has(i.mint)))
    },

    capTable: (scope, companyId, mint, at) => {
      if (!visible(index, scope, companyId)) return Promise.resolve(null)
      const company = index.companies.find((c) => c.companyId === companyId)
      const token =
        mint === undefined ? company?.tokens[0] : company?.tokens.find((t) => t.mint === mint)
      if (company === undefined || token === undefined) return Promise.resolve(null)
      const totalSupply = BigInt(token.totalSupply)
      const rows = index.holdings
        .filter((h) => h.mint === token.mint && h.amount > 0n)
        .sort((a, b) => (a.amount === b.amount ? 0 : a.amount > b.amount ? -1 : 1))
      const table: CapTable = {
        mint: token.mint,
        at: at.toISOString(),
        totalSupply: token.totalSupply,
        treasury: (rows.find((h) => h.wallet === company.company)?.amount ?? 0n).toString(),
        holders: rows
          .filter((h) => h.wallet !== company.company)
          .map((h) => ({
            wallet: h.wallet as WalletAddress,
            amount: h.amount.toString(),
            pct: percentOf(h.amount, totalSupply),
            vested: h.amount.toString(),
            unvested: '0',
            sources:
              h.distributed > 0n
                ? [{ kind: 'distribution', amount: h.distributed.toString() }]
                : [],
          })),
      }
      return Promise.resolve(table)
    },

    journal: (scope, companyId, query) => {
      if (!visible(index, scope, companyId)) return Promise.resolve({ items: [], nextCursor: null })
      const cursor = query.cursor === undefined ? null : decodeCursor(query.cursor)
      const rows = index.attempts
        .filter((a) => a.companyId === companyId)
        .filter((a) => query.mint === undefined || a.mint === query.mint)
        .filter(
          (a) => query.from === undefined || Date.parse(a.blockTime) >= Date.parse(query.from),
        )
        .filter((a) => query.to === undefined || Date.parse(a.blockTime) <= Date.parse(query.to))
        .filter(
          (a) =>
            cursor === null ||
            Date.parse(a.blockTime) < cursor.blockTime.getTime() ||
            (Date.parse(a.blockTime) === cursor.blockTime.getTime() && BigInt(a.id) < cursor.id),
        )
        .sort(
          (a, b) =>
            Date.parse(b.blockTime) - Date.parse(a.blockTime) || Number(b.id) - Number(a.id),
        )
      const page = rows.slice(0, query.limit)
      const last = page.at(-1)
      return Promise.resolve({
        items: page.map(({ companyId: _c, reportedBy: _r, ...entry }) => entry),
        nextCursor:
          rows.length > query.limit && last !== undefined
            ? encodeCursor(new Date(last.blockTime), BigInt(last.id))
            : null,
      })
    },

    feed: (scope, companyId, since) => {
      if (!visible(index, scope, companyId)) {
        return Promise.resolve({
          events: [],
          marks: since ?? { attemptId: 0n, statusEventId: 0n, policySlot: 0n, policyKeys: [] },
        })
      }
      const attempts = index.attempts.filter((a) => a.companyId === companyId)
      const statuses = index.statusEvents.filter((s) => s.companyId === companyId)
      const policies = index.policyVersions.filter((p) => p.companyId === companyId)
      const max = (values: bigint[]) => values.reduce((m, v) => (v > m ? v : m), 0n)
      const keysAt = (slot: bigint) =>
        policies.filter((p) => p.slot === slot).map((p) => policyKey(p.mint, p.version))
      if (since === null) {
        const policySlot = max(policies.map((p) => p.slot))
        return Promise.resolve({
          events: [],
          marks: {
            attemptId: max(attempts.map((a) => BigInt(a.id))),
            statusEventId: max(statuses.map((s) => s.id)),
            policySlot,
            policyKeys: keysAt(policySlot),
          },
        })
      }
      const newAttempts = attempts.filter((a) => BigInt(a.id) > since.attemptId)
      const newStatuses = statuses.filter((s) => s.id > since.statusEventId)
      const newPolicies = policies.filter(
        (p) =>
          p.slot >= since.policySlot && !since.policyKeys.includes(policyKey(p.mint, p.version)),
      )
      const events: FeedEvent[] = [
        ...newAttempts.map(
          ({ companyId: _c, reportedBy: _r, ...entry }): FeedEvent => ({ kind: 'attempt', entry }),
        ),
        ...newStatuses.map((s): FeedEvent => ({ kind: 'status', investor: s.investor })),
        ...newPolicies.map(
          (p): FeedEvent => ({
            kind: 'policy',
            mint: p.mint,
            policy: p.policy,
            policyVersion: p.version,
            setAt: p.setAt,
          }),
        ),
      ]
      const policySlot = max([since.policySlot, ...newPolicies.map((p) => p.slot)])
      const marks: FeedMarks = {
        attemptId: max([since.attemptId, ...newAttempts.map((a) => BigInt(a.id))]),
        statusEventId: max([since.statusEventId, ...newStatuses.map((s) => s.id)]),
        policySlot,
        policyKeys: keysAt(policySlot),
      }
      return Promise.resolve({ events, marks })
    },

    reportAttempt: (scope, report, reportedBy, now) => {
      const company = companyOf(report.mint)
      if (company === undefined || !visible(index, scope, company.companyId)) {
        return Promise.resolve(null)
      }
      const id = nextAttemptId++
      index.attempts.push({
        id: id.toString(),
        companyId: company.companyId,
        mint: report.mint,
        sourceOwner: report.sourceOwner,
        destOwner: report.destOwner,
        amount: report.amount,
        outcome: 'rejected',
        reasonCode: report.reasonCode,
        origin: 'simulation',
        fromTreasury: false,
        policyVersion: null,
        txSignature: null,
        slot: null,
        blockTime: now.toISOString(),
        logs: report.logs,
        reportedBy,
      })
      return Promise.resolve({ id })
    },
  }
}
