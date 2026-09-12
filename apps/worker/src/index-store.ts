import { type Db, schema, type Tx } from '@caprail/db'
import { and, eq, isNull, lt, lte, or } from 'drizzle-orm'

export type CompanyRow = typeof schema.companies.$inferInsert
export type TokenRow = typeof schema.tokens.$inferInsert
export type PolicyVersionRow = typeof schema.policyVersions.$inferInsert
export type InvestorRow = typeof schema.investors.$inferInsert
export type InvestorStatusEventRow = typeof schema.investorStatusEvents.$inferInsert
export type AttemptRow = typeof schema.transferAttempts.$inferInsert
export type HoldingRow = typeof schema.holdings.$inferInsert

// What the applier needs to know about a mint it has already indexed.
export type TokenRef = { mint: string; companyId: bigint; treasury: string }

export type Holding = {
  amount: bigint
  distributed: bigint
  lastSlot: bigint
  verifiedAt: Date | null
}

export type Roles = { admin: string; complianceOfficer: string; setAt: Date }

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
}

export type IndexStore = {
  // One chain transaction = one database transaction: a journal row without its
  // holdings delta, or the reverse, must not survive a crash in between.
  write: <T>(fn: (index: IndexWriter) => Promise<T>) => Promise<T>
}

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
  }
}

export function indexStore(db: Db): IndexStore {
  return {
    write: (fn) => db.transaction((tx) => fn(writerOn(tx))),
  }
}
