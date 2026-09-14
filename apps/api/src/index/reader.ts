import { type Db, schema, type TenantScope, type Tx, withTenant } from '@caprail/db'
import type {
  AttemptReport,
  CapTable,
  CompanyView,
  FeedEvent,
  Holder,
  InvestorView,
  JournalEntry,
  JournalPage,
  JournalQuery,
  Membership,
  Role,
  TokenView,
  WalletAddress,
} from '@caprail/shared'
import { and, asc, desc, eq, gt, gte, lte, type SQL, sql } from 'drizzle-orm'

// High-water marks of the three tables the panel's feed watches. `policy_versions`
// has no serial id, so its mark is the slot (inclusive) plus the `mint:version` keys
// already seen at that slot — two policies of one company can land in one slot.
export type FeedMarks = {
  attemptId: bigint
  statusEventId: bigint
  policySlot: bigint
  policyKeys: string[]
}

export const policyKey = (mint: string, version: number): string => `${mint}:${version}`

export type FeedBatch = { events: FeedEvent[]; marks: FeedMarks }

// Everything the API reads from (or writes to) the index, always inside
// `withTenant` — the role switch is what makes the RLS policies apply, so a method
// here never sees a row the session could not. Scoping is the caller's: a company
// route passes the company, sign-in passes the wallet alone.
export type IndexReader = {
  membershipsOf: (wallet: WalletAddress) => Promise<Membership[]>
  rolesOf: (companyId: string, wallet: WalletAddress) => Promise<Role[]>
  company: (scope: TenantScope, companyId: string) => Promise<CompanyView | null>
  investors: (scope: TenantScope, companyId: string) => Promise<InvestorView[]>
  // null: the company has no such token (or no token at all when `mint` is omitted).
  capTable: (
    scope: TenantScope,
    companyId: string,
    mint: string | undefined,
    at: Date,
  ) => Promise<CapTable | null>
  journal: (scope: TenantScope, companyId: string, query: JournalQuery) => Promise<JournalPage>
  // `since === null` returns the current marks and no events: a fresh stream starts
  // from now, not from the beginning of the journal.
  feed: (scope: TenantScope, companyId: string, since: FeedMarks | null) => Promise<FeedBatch>
  // null: the mint is not visible to the reporter, which the route answers as
  // NOT_FOUND — the same as a mint that does not exist.
  reportAttempt: (
    scope: TenantScope,
    report: AttemptReport,
    reportedBy: WalletAddress,
    now: Date,
  ) => Promise<{ id: bigint } | null>
}

const iso = (date: Date): string => date.toISOString()

// The journal pages newest first on (block_time, id); the cursor is that pair,
// opaque to the client.
export function encodeCursor(blockTime: Date, id: bigint): string {
  return Buffer.from(`${blockTime.getTime()}:${id}`).toString('base64url')
}

export function decodeCursor(cursor: string): { blockTime: Date; id: bigint } | null {
  const match = /^(\d{1,15}):(\d{1,19})$/.exec(Buffer.from(cursor, 'base64url').toString())
  if (match?.[1] === undefined || match[2] === undefined) return null
  return { blockTime: new Date(Number(match[1])), id: BigInt(match[2]) }
}

type TokenRow = typeof schema.tokens.$inferSelect
type InvestorRow = typeof schema.investors.$inferSelect
type AttemptRow = typeof schema.transferAttempts.$inferSelect
type HoldingRow = typeof schema.holdings.$inferSelect

function tokenView(row: TokenRow): TokenView {
  return {
    mint: row.mint,
    treasury: row.treasury,
    name: row.name,
    symbol: row.symbol,
    decimals: row.decimals,
    totalSupply: row.totalSupply.toString(),
    policy: {
      requireAccreditation: row.requireAccreditation,
      requireRofr: row.requireRofr,
      rofrWindowSecs: row.rofrWindowSecs,
    },
    policyVersion: row.policyVersion,
    createdAt: row.createdAt === null ? null : iso(row.createdAt),
  }
}

function investorView(row: InvestorRow): InvestorView {
  return {
    mint: row.mint,
    wallet: row.wallet as WalletAddress,
    status: row.status,
    expiresAt: iso(row.expiresAt),
    jurisdiction: row.jurisdiction,
    investorType: row.investorType,
    updatedAt: iso(row.updatedAt),
    updatedBy: row.updatedBy as WalletAddress,
  }
}

export function journalEntry(row: AttemptRow): JournalEntry {
  return {
    id: row.id.toString(),
    mint: row.mint,
    sourceOwner: row.sourceOwner,
    destOwner: row.destOwner,
    amount: row.amount === null ? null : row.amount.toString(),
    outcome: row.outcome,
    reasonCode: row.reasonCode,
    origin: row.origin,
    fromTreasury: row.fromTreasury,
    policyVersion: row.policyVersion,
    txSignature: row.txSignature,
    slot: row.slot === null ? null : Number(row.slot),
    blockTime: iso(row.blockTime),
    logs: row.logs,
  }
}

// Percent of the issue with two decimals, computed in integers: 10 000 × amount /
// supply, then /100 — no float until the very end.
export function percentOf(amount: bigint, totalSupply: bigint): number {
  if (totalSupply === 0n) return 0
  return Number((amount * 10_000n) / totalSupply) / 100
}

function holder(row: HoldingRow, totalSupply: bigint): Holder {
  return {
    wallet: row.wallet as WalletAddress,
    amount: row.amount.toString(),
    pct: percentOf(row.amount, totalSupply),
    // Vesting arrives with US3 (grants); until then everything held is vested.
    vested: row.amount.toString(),
    unvested: '0',
    sources:
      row.distributed > 0n ? [{ kind: 'distribution', amount: row.distributed.toString() }] : [],
  }
}

function journalConditions(companyId: bigint, query: JournalQuery): SQL[] {
  const { transferAttempts } = schema
  const cursor = query.cursor === undefined ? null : decodeCursor(query.cursor)
  const conditions: SQL[] = [eq(transferAttempts.companyId, companyId)]
  if (query.mint !== undefined) conditions.push(eq(transferAttempts.mint, query.mint))
  if (query.from !== undefined)
    conditions.push(gte(transferAttempts.blockTime, new Date(query.from)))
  if (query.to !== undefined) conditions.push(lte(transferAttempts.blockTime, new Date(query.to)))
  if (cursor !== null) {
    // Row comparison keeps the page boundary exact on ties; the raw parameter must
    // be a string — postgres-js does not serialise a Date drizzle has not mapped.
    conditions.push(
      sql`(${transferAttempts.blockTime}, ${transferAttempts.id}) < (${cursor.blockTime.toISOString()}::timestamptz, ${cursor.id})`,
    )
  }
  return conditions
}

async function companyTokens(tx: Tx, companyId: bigint): Promise<TokenRow[]> {
  return tx
    .select()
    .from(schema.tokens)
    .where(eq(schema.tokens.companyId, companyId))
    .orderBy(asc(schema.tokens.createdSlot), asc(schema.tokens.mint))
}

export function drizzleIndexReader(db: Db): IndexReader {
  const { companies, tokens, investors, holdings, transferAttempts, investorStatusEvents } = schema
  const { policyVersions } = schema

  // The wallet's own view of `companies` is exactly its memberships: the SELECT
  // policy admits a row for a role key or a registry entry, nothing else.
  const membershipsOf = (wallet: WalletAddress): Promise<Membership[]> =>
    withTenant(db, { wallet }, async (tx) => {
      const rows = await tx
        .select({
          companyId: companies.companyId,
          admin: companies.admin,
          complianceOfficer: companies.complianceOfficer,
          investor: sql<boolean>`exists (select 1 from investors i where i.company_id = ${companies.companyId} and i.wallet = ${wallet})`,
        })
        .from(companies)
        .orderBy(asc(companies.companyId))
      const memberships: Membership[] = []
      for (const row of rows) {
        const companyId = row.companyId.toString()
        if (row.admin === wallet) memberships.push({ companyId, role: 'admin' })
        if (row.complianceOfficer === wallet)
          memberships.push({ companyId, role: 'compliance_officer' })
        if (row.investor) memberships.push({ companyId, role: 'investor' })
      }
      return memberships
    })

  return {
    membershipsOf,

    rolesOf: async (companyId, wallet) =>
      (await membershipsOf(wallet)).filter((m) => m.companyId === companyId).map((m) => m.role),

    company: (scope, companyId) =>
      withTenant(db, scope, async (tx) => {
        const rows = await tx
          .select()
          .from(companies)
          .where(eq(companies.companyId, BigInt(companyId)))
          .limit(1)
        const row = rows[0]
        if (row === undefined) return null
        const tokenRows = await companyTokens(tx, row.companyId)
        return {
          companyId: row.companyId.toString(),
          company: row.company,
          name: row.name,
          admin: row.admin as WalletAddress,
          complianceOfficer: row.complianceOfficer as WalletAddress,
          rolesSetAt: row.rolesSetAt === null ? null : iso(row.rolesSetAt),
          tokens: tokenRows.map(tokenView),
        }
      }),

    investors: (scope, companyId) =>
      withTenant(db, scope, async (tx) => {
        const rows = await tx
          .select()
          .from(investors)
          .where(eq(investors.companyId, BigInt(companyId)))
          .orderBy(desc(investors.updatedAt), asc(investors.wallet))
        return rows.map(investorView)
      }),

    capTable: (scope, companyId, mint, at) =>
      withTenant(db, scope, async (tx) => {
        const company = BigInt(companyId)
        const tokenRows = await companyTokens(tx, company)
        const token = mint === undefined ? tokenRows[0] : tokenRows.find((t) => t.mint === mint)
        if (token === undefined) return null
        const treasuryOwner = (
          await tx
            .select({ company: companies.company })
            .from(companies)
            .where(eq(companies.companyId, company))
            .limit(1)
        )[0]?.company
        const rows = await tx
          .select()
          .from(holdings)
          .where(and(eq(holdings.mint, token.mint), gt(holdings.amount, 0n)))
          .orderBy(desc(holdings.amount), asc(holdings.wallet))
        const treasury = rows.find((row) => row.wallet === treasuryOwner)?.amount ?? 0n
        return {
          mint: token.mint,
          at: iso(at),
          totalSupply: token.totalSupply.toString(),
          treasury: treasury.toString(),
          holders: rows
            .filter((row) => row.wallet !== treasuryOwner)
            .map((row) => holder(row, token.totalSupply)),
        }
      }),

    journal: (scope, companyId, query) =>
      withTenant(db, scope, async (tx) => {
        // One row past the page tells whether there is a next page without a count.
        const rows = await tx
          .select()
          .from(transferAttempts)
          .where(and(...journalConditions(BigInt(companyId), query)))
          .orderBy(desc(transferAttempts.blockTime), desc(transferAttempts.id))
          .limit(query.limit + 1)
        const page = rows.slice(0, query.limit)
        const last = page.at(-1)
        return {
          items: page.map(journalEntry),
          nextCursor:
            rows.length > query.limit && last !== undefined
              ? encodeCursor(last.blockTime, last.id)
              : null,
        }
      }),

    feed: (scope, companyId, since) =>
      withTenant(db, scope, async (tx) => {
        const company = BigInt(companyId)
        const policiesAt = async (slot: bigint) =>
          (
            await tx
              .select({ mint: policyVersions.mint, version: policyVersions.version })
              .from(policyVersions)
              .where(and(eq(policyVersions.companyId, company), eq(policyVersions.slot, slot)))
          ).map((row) => policyKey(row.mint, row.version))
        if (since === null) {
          const [attempt, status, policy] = await Promise.all([
            tx
              .select({ max: sql<string | null>`max(${transferAttempts.id})` })
              .from(transferAttempts)
              .where(eq(transferAttempts.companyId, company)),
            tx
              .select({ max: sql<string | null>`max(${investorStatusEvents.id})` })
              .from(investorStatusEvents)
              .where(eq(investorStatusEvents.companyId, company)),
            tx
              .select({ max: sql<string | null>`max(${policyVersions.slot})` })
              .from(policyVersions)
              .where(eq(policyVersions.companyId, company)),
          ])
          const policySlot = BigInt(policy[0]?.max ?? 0)
          return {
            events: [],
            marks: {
              attemptId: BigInt(attempt[0]?.max ?? 0),
              statusEventId: BigInt(status[0]?.max ?? 0),
              policySlot,
              policyKeys: await policiesAt(policySlot),
            },
          }
        }
        const [attempts, statuses, policyRows] = await Promise.all([
          tx
            .select()
            .from(transferAttempts)
            .where(
              and(
                eq(transferAttempts.companyId, company),
                gt(transferAttempts.id, since.attemptId),
              ),
            )
            .orderBy(asc(transferAttempts.id)),
          tx
            .select({ event: investorStatusEvents, investor: investors })
            .from(investorStatusEvents)
            .innerJoin(
              investors,
              and(
                eq(investors.mint, investorStatusEvents.mint),
                eq(investors.wallet, investorStatusEvents.wallet),
              ),
            )
            .where(
              and(
                eq(investorStatusEvents.companyId, company),
                gt(investorStatusEvents.id, since.statusEventId),
              ),
            )
            .orderBy(asc(investorStatusEvents.id)),
          tx
            .select()
            .from(policyVersions)
            .where(
              and(
                eq(policyVersions.companyId, company),
                gte(policyVersions.slot, since.policySlot),
              ),
            )
            .orderBy(asc(policyVersions.slot), asc(policyVersions.version)),
        ])
        const policies = policyRows.filter(
          (row) => !since.policyKeys.includes(policyKey(row.mint, row.version)),
        )
        const events: FeedEvent[] = [
          ...attempts.map((row): FeedEvent => ({ kind: 'attempt', entry: journalEntry(row) })),
          ...statuses.map(
            (row): FeedEvent => ({ kind: 'status', investor: investorView(row.investor) }),
          ),
          ...policies.map(
            (row): FeedEvent => ({
              kind: 'policy',
              mint: row.mint,
              policy: {
                requireAccreditation: row.requireAccreditation,
                requireRofr: row.requireRofr,
                rofrWindowSecs: row.rofrWindowSecs,
              },
              policyVersion: row.version,
              setAt: row.setAt === null ? null : iso(row.setAt),
            }),
          ),
        ]
        const policySlot = policies.at(-1)?.slot ?? since.policySlot
        return {
          events,
          marks: {
            attemptId: attempts.at(-1)?.id ?? since.attemptId,
            statusEventId: statuses.at(-1)?.event.id ?? since.statusEventId,
            policySlot,
            policyKeys: [
              ...(policySlot === since.policySlot ? since.policyKeys : []),
              ...policies
                .filter((row) => row.slot === policySlot)
                .map((row) => policyKey(row.mint, row.version)),
            ],
          },
        }
      }),

    reportAttempt: (scope, report, reportedBy, now) =>
      withTenant(db, scope, async (tx) => {
        // The mint row is visible only to members of its company — a stranger's report
        // on a mint they cannot see is indistinguishable from an unknown mint.
        const token = (
          await tx
            .select({ companyId: tokens.companyId })
            .from(tokens)
            .where(eq(tokens.mint, report.mint))
            .limit(1)
        )[0]
        if (token === undefined) return null
        const inserted = await tx
          .insert(transferAttempts)
          .values({
            mint: report.mint,
            companyId: token.companyId,
            sourceOwner: report.sourceOwner,
            destOwner: report.destOwner,
            amount: BigInt(report.amount),
            outcome: 'rejected',
            reasonCode: report.reasonCode,
            origin: 'simulation',
            fromTreasury: false,
            policyVersion: null,
            txSignature: null,
            eventIndex: 0,
            slot: null,
            blockTime: now,
            logs: report.logs,
            reportedBy,
          })
          .returning({ id: transferAttempts.id })
        const row = inserted[0]
        return row === undefined ? null : { id: row.id }
      }),
  }
}
