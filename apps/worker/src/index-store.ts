import { type Db, schema, type Tx } from '@caprail/db'
import type { OfferStaleReason, OfferStatus } from '@caprail/shared'
import { and, asc, eq, gt, inArray, isNull, lt, lte, or, sql } from 'drizzle-orm'
import type { OfferBook } from './stale.ts'

export type CompanyRow = typeof schema.companies.$inferInsert
export type TokenRow = typeof schema.tokens.$inferInsert
export type PolicyVersionRow = typeof schema.policyVersions.$inferInsert
export type InvestorRow = typeof schema.investors.$inferInsert
export type InvestorStatusEventRow = typeof schema.investorStatusEvents.$inferInsert
export type AttemptRow = typeof schema.transferAttempts.$inferInsert
export type HoldingRow = typeof schema.holdings.$inferInsert
export type OfferRow = typeof schema.offers.$inferInsert
export type TradeRow = typeof schema.trades.$inferInsert

// What the applier needs to know about a mint it has already indexed.
export type TokenRef = { mint: string; companyId: bigint; treasury: string }

export type Holding = {
  amount: bigint
  distributed: bigint
  lastSlot: bigint
  verifiedAt: Date | null
}

export type Roles = { admin: string; complianceOfficer: string; setAt: Date }

// What a trade or a cancellation needs to know about the offer it closes or shrinks.
export type OfferRef = {
  offer: string
  mint: string
  companyId: bigint
  status: OfferStatus
  remaining: bigint
  available: bigint | null
  staleReason: OfferStaleReason | null
}

// The offer after a trade or a cancellation. Both invalidate the last reading of
// the seller's account (`checked_at` → null) and move `touched_slot` forward.
export type OfferChange = {
  status: OfferStatus
  remaining: bigint
  available: bigint | null
  staleReason: OfferStaleReason | null
  closedAt: Date | null
  delegationRevoked?: boolean
  slot: bigint
  updatedAt: Date
}

// Every write the applier makes, as the index sees it — so the applier can be
// tested against a map and the SQL below stays a thin translation. The mirror
// writes are idempotent by construction (insert-if-absent, update-if-newer); the
// journal insert reports whether the row was new, which is what guards the
// holdings arithmetic against a replayed transaction.
export type IndexWriter = {
  companyIdOf: (company: string) => Promise<bigint | null>
  tokenOf: (mint: string) => Promise<TokenRef | null>
  // Wallets the index already associates with the mint: the registry plus every
  // holder — the candidates whose ATA a refused transfer's destination may be.
  walletsOf: (mint: string) => Promise<string[]>
  createCompany: (row: CompanyRow) => Promise<void>
  createToken: (token: TokenRow, policy: PolicyVersionRow, treasury: HoldingRow) => Promise<void>
  setPolicy: (policy: PolicyVersionRow, updatedAt: Date) => Promise<void>
  setRoles: (companyId: bigint, roles: Roles) => Promise<void>
  setInvestorStatus: (event: InvestorStatusEventRow, investor: InvestorRow) => Promise<void>
  // true when the row was inserted; false when (tx_signature, event_index) was there.
  recordAttempt: (row: AttemptRow) => Promise<boolean>
  holding: (mint: string, wallet: string) => Promise<Holding | null>
  putHolding: (row: HoldingRow) => Promise<void>
  offer: (offer: string) => Promise<OfferRef | null>
  // true when the row was inserted.
  createOffer: (row: OfferRow) => Promise<boolean>
  // true when the row was inserted; false when (tx_signature, event_index) was there.
  recordTrade: (row: TradeRow) => Promise<boolean>
  // Applies only to an open offer, and only forward: a trade must leave less than
  // there is, so a replayed or out-of-order one changes nothing.
  changeOffer: (offer: string, change: OfferChange) => Promise<void>
  // Something at `slot` moved one of these wallets' token accounts for the mint:
  // readings of their open offers from before `slot` no longer count.
  touchOffers: (mint: string, wallets: readonly string[], slot: bigint) => Promise<void>
}

export type IndexStore = {
  // One chain transaction = one database transaction: a journal row without its
  // holdings delta, or the reverse, must not survive a crash in between.
  write: <T>(fn: (index: IndexWriter) => Promise<T>) => Promise<T>
}

// Raw SQL parameters skip the column's driver mapping, so a bigint goes as text.
const slotAtLeast = (slot: bigint) =>
  sql`greatest(${schema.offers.touchedSlot}, ${String(slot)}::bigint)`

function writerOn(tx: Tx): IndexWriter {
  return {
    companyIdOf: async (company) => {
      const rows = await tx
        .select({ companyId: schema.companies.companyId })
        .from(schema.companies)
        .where(eq(schema.companies.company, company))
        .limit(1)
      return rows[0]?.companyId ?? null
    },

    tokenOf: async (mint) => {
      const rows = await tx
        .select({
          mint: schema.tokens.mint,
          companyId: schema.tokens.companyId,
          treasury: schema.tokens.treasury,
        })
        .from(schema.tokens)
        .where(eq(schema.tokens.mint, mint))
        .limit(1)
      return rows[0] ?? null
    },

    walletsOf: async (mint) => {
      const [investors, holders] = await Promise.all([
        tx
          .select({ wallet: schema.investors.wallet })
          .from(schema.investors)
          .where(eq(schema.investors.mint, mint)),
        tx
          .select({ wallet: schema.holdings.wallet })
          .from(schema.holdings)
          .where(eq(schema.holdings.mint, mint)),
      ])
      return [...new Set([...investors, ...holders].map((row) => row.wallet))]
    },

    createCompany: async (row) => {
      await tx.insert(schema.companies).values(row).onConflictDoNothing()
    },

    createToken: async (token, policy, treasury) => {
      await tx.insert(schema.tokens).values(token).onConflictDoNothing()
      await tx.insert(schema.policyVersions).values(policy).onConflictDoNothing()
      await tx.insert(schema.holdings).values(treasury).onConflictDoNothing()
    },

    setPolicy: async (policy, updatedAt) => {
      await tx.insert(schema.policyVersions).values(policy).onConflictDoNothing()
      await tx
        .update(schema.tokens)
        .set({
          requireAccreditation: policy.requireAccreditation,
          requireRofr: policy.requireRofr,
          rofrWindowSecs: policy.rofrWindowSecs,
          policyVersion: policy.version,
          updatedAt,
        })
        .where(
          and(eq(schema.tokens.mint, policy.mint), lt(schema.tokens.policyVersion, policy.version)),
        )
    },

    // `<=` on the event clock: two role changes in one second land in chain order,
    // and the later one must still win.
    setRoles: async (companyId, roles) => {
      await tx
        .update(schema.companies)
        .set({
          admin: roles.admin,
          complianceOfficer: roles.complianceOfficer,
          rolesSetAt: roles.setAt,
          updatedAt: roles.setAt,
        })
        .where(
          and(
            eq(schema.companies.companyId, companyId),
            or(isNull(schema.companies.rolesSetAt), lte(schema.companies.rolesSetAt, roles.setAt)),
          ),
        )
    },

    setInvestorStatus: async (event, investor) => {
      await tx.insert(schema.investorStatusEvents).values(event).onConflictDoNothing()
      const { mint: _mint, wallet: _wallet, companyId: _companyId, ...current } = investor
      await tx
        .insert(schema.investors)
        .values(investor)
        .onConflictDoUpdate({
          target: [schema.investors.mint, schema.investors.wallet],
          set: current,
          setWhere: lte(schema.investors.slot, investor.slot),
        })
    },

    recordAttempt: async (row) => {
      const inserted = await tx
        .insert(schema.transferAttempts)
        .values(row)
        .onConflictDoNothing()
        .returning({ id: schema.transferAttempts.id })
      return inserted.length > 0
    },

    holding: async (mint, wallet) => {
      const rows = await tx
        .select({
          amount: schema.holdings.amount,
          distributed: schema.holdings.distributed,
          lastSlot: schema.holdings.lastSlot,
          verifiedAt: schema.holdings.verifiedAt,
        })
        .from(schema.holdings)
        .where(and(eq(schema.holdings.mint, mint), eq(schema.holdings.wallet, wallet)))
        .limit(1)
      return rows[0] ?? null
    },

    putHolding: async (row) => {
      const { mint: _mint, wallet: _wallet, companyId: _companyId, ...current } = row
      await tx
        .insert(schema.holdings)
        .values(row)
        .onConflictDoUpdate({
          target: [schema.holdings.mint, schema.holdings.wallet],
          set: current,
        })
    },

    offer: async (offer) => {
      const rows = await tx
        .select({
          offer: schema.offers.offer,
          mint: schema.offers.mint,
          companyId: schema.offers.companyId,
          status: schema.offers.status,
          remaining: schema.offers.remaining,
          available: schema.offers.available,
          staleReason: schema.offers.staleReason,
        })
        .from(schema.offers)
        .where(eq(schema.offers.offer, offer))
        .limit(1)
      return rows[0] ?? null
    },

    createOffer: async (row) => {
      const inserted = await tx
        .insert(schema.offers)
        .values(row)
        .onConflictDoNothing()
        .returning({ offer: schema.offers.offer })
      return inserted.length > 0
    },

    recordTrade: async (row) => {
      const inserted = await tx
        .insert(schema.trades)
        .values(row)
        .onConflictDoNothing()
        .returning({ offer: schema.trades.offer })
      return inserted.length > 0
    },

    changeOffer: async (offer, change) => {
      const { slot, ...fields } = change
      await tx
        .update(schema.offers)
        .set({
          ...fields,
          checkedAt: null,
          touchedSlot: slotAtLeast(slot),
        })
        .where(
          and(
            eq(schema.offers.offer, offer),
            eq(schema.offers.status, 'open'),
            change.status === 'cancelled'
              ? undefined
              : gt(schema.offers.remaining, change.remaining),
          ),
        )
    },

    // A reading taken at or after `slot` already saw the change and stays.
    touchOffers: async (mint, wallets, slot) => {
      await tx
        .update(schema.offers)
        .set({
          touchedSlot: slotAtLeast(slot),
          checkedAt: sql`CASE WHEN ${schema.offers.checkedSlot} >= ${String(slot)}::bigint THEN ${schema.offers.checkedAt} END`,
        })
        .where(
          and(
            eq(schema.offers.mint, mint),
            inArray(schema.offers.seller, [...wallets]),
            eq(schema.offers.status, 'open'),
          ),
        )
    },
  }
}

export function indexStore(db: Db): IndexStore {
  return {
    write: (fn) => db.transaction((tx) => fn(writerOn(tx))),
  }
}

// The stale sweep's side of `offers`: outside the chain transaction, one statement
// per offer, so a reading never holds a lock across an RPC call.
export function offerBook(db: Db): OfferBook {
  const o = schema.offers
  return {
    due: (before, limit) =>
      db
        .select({ offer: o.offer, mint: o.mint, seller: o.seller, remaining: o.remaining })
        .from(o)
        .where(and(eq(o.status, 'open'), or(isNull(o.checkedAt), lt(o.checkedAt, before))))
        .orderBy(sql`${o.checkedAt} ASC NULLS FIRST`, asc(o.offer))
        .limit(limit),

    record: async (offer, reading) => {
      const slot = String(reading.checkedSlot)
      const written = await db
        .update(o)
        .set(reading)
        .where(
          and(
            eq(o.offer, offer.offer),
            eq(o.status, 'open'),
            eq(o.remaining, offer.remaining),
            sql`${o.touchedSlot} <= ${slot}::bigint`,
            sql`(${o.checkedSlot} IS NULL OR ${o.checkedSlot} <= ${slot}::bigint)`,
          ),
        )
        .returning({ offer: o.offer })
      return written.length > 0
    },
  }
}
