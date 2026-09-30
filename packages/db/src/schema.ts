import {
  ATTEMPT_ORIGINS,
  ATTEMPT_OUTCOMES,
  INVESTOR_STATUSES,
  OFFER_STALE_REASONS,
  OFFER_STATUSES,
} from '@caprail/shared'
import { type SQL, sql } from 'drizzle-orm'
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  index,
  integer,
  numeric,
  pgEnum,
  pgPolicy,
  pgRole,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core'
import { anonRole, authenticatedRole } from 'drizzle-orm/supabase'

// Supabase exposes `public` to both of its HTTP roles; nothing here is meant to be
// read that way. RESTRICTIVE, not merely "RLS on with no policies": restrictive
// policies AND together, so a permissive one added later from the dashboard still
// opens nothing. Services connect as the owner role, which RLS does not touch.
const denyAll = (table: string) =>
  pgPolicy(`${table}_deny_all`, {
    as: 'restrictive',
    for: 'all',
    to: [anonRole, authenticatedRole],
    using: sql`false`,
    withCheck: sql`false`,
  })

// The role the API assumes for the duration of a `withTenant` transaction. Both
// `postgres` (Supabase's admin role, BYPASSRLS) and the table owner are exempt from
// RLS, so the `app.*` policies below are only enforced for a role that is neither:
// NOLOGIN, no BYPASSRLS, granted to `postgres` so `SET LOCAL ROLE` is allowed. Its
// grants (SELECT on the index tables, INSERT on `transfer_attempts`) are plain SQL
// at the end of the migration — drizzle-kit does not model grants.
export const apiRole = pgRole('caprail_api')

// Scope comes from the session via `set_config` in `withTenant`. `company_id` is set
// only for admin / compliance-officer sessions of that company; an investor session
// carries the wallet alone and sees its own rows. '' (the value `withTenant` writes
// for an absent dimension) becomes NULL, and NULL matches nothing.
const scopedCompanyId = sql`nullif(current_setting('app.company_id', true), '')::numeric`
const scopedWallet = sql`nullif(current_setting('app.wallet', true), '')`

// `caprail_admits(mint, wallet, at)` — the hook's admission check over the index
// (migration 0004): true when the mint's policy does not require accreditation, or
// the wallet's record is `approved` and expires after `at`; false for a null wallet.
export const ADMITS_FUNCTION = 'caprail_admits'
export const admitsSql = (mint: SQL | AnyPgColumn, wallet: SQL | string, at: SQL): SQL =>
  sql`${sql.raw(ADMITS_FUNCTION)}(${mint}, ${wallet}, ${at})`

const apiSelect = (table: string, using: SQL) =>
  pgPolicy(`${table}_api_select`, { for: 'select', to: apiRole, using })

// Amounts are u64 on chain; int8 tops out at 2^63 - 1. numeric(20, 0) holds the full
// range and drizzle hands it over as bigint.
const u64 = (name: string) => numeric(name, { precision: 20, scale: 0, mode: 'bigint' })
const unixTime = (name: string) => timestamp(name, { withTimezone: true })

// The enum literals are `packages/shared`'s: the index stores what the event said,
// and the API answers with the same names.
export const investorStatus = pgEnum('investor_status', INVESTOR_STATUSES)
export const attemptOutcome = pgEnum('attempt_outcome', ATTEMPT_OUTCOMES)
// `chain` rows come from the worker (event or failed transaction); `simulation` rows
// are reported by the panel when the wallet's preflight refused the transfer, which
// never reaches the chain (PLAN → risk 2).
export const attemptOrigin = pgEnum('attempt_origin', ATTEMPT_ORIGINS)
export const offerStatus = pgEnum('offer_status', OFFER_STATUSES)
export const offerStaleReason = pgEnum('offer_stale_reason', OFFER_STALE_REASONS)

export const indexerCursor = pgTable(
  'indexer_cursor',
  {
    program: text('program').primaryKey(),
    signature: text('signature').notNull(),
    slot: bigint('slot', { mode: 'bigint' }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  () => [denyAll('indexer_cursor')],
)

// One outstanding nonce per wallet: a new request replaces the old one, and verify
// deletes the row, which is what makes it single-use.
export const authNonces = pgTable(
  'auth_nonces',
  {
    wallet: text('wallet').primaryKey(),
    nonce: text('nonce').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  () => [denyAll('auth_nonces')],
)

// ── Index of the program state (US1) — a mirror, never the source of truth ────────

// Mirror of `Company`. `company_id` is the u64 the creator chose and the PDA seed, so
// it is unique on chain; it is also the tenant key (`app.company_id`, `/companies/:id`,
// JWT memberships). Events carry the PDA, hence both columns. The id is a full u64
// like the amounts — the first devnet company above 2^63 did not fit an int8 (T032).
export const companies = pgTable(
  'companies',
  {
    companyId: u64('company_id').primaryKey(),
    company: text('company').notNull().unique(),
    admin: text('admin').notNull(),
    complianceOfficer: text('compliance_officer').notNull(),
    name: text('name').notNull(),
    createdSignature: text('created_signature').notNull(),
    createdSlot: bigint('created_slot', { mode: 'bigint' }).notNull(),
    // From `RolesSet`; null until the roles are changed for the first time.
    rolesSetAt: unixTime('roles_set_at'),
    updatedAt: unixTime('updated_at').notNull(),
  },
  (t) => [
    // Membership lookup at sign-in: which companies name this wallet in a role.
    index('companies_admin_idx').on(t.admin),
    index('companies_compliance_officer_idx').on(t.complianceOfficer),
    denyAll('companies'),
    // A company row is visible to its scoped session, to either role key, and to any
    // wallet in its registry — the same three sources `memberships` are computed from.
    // Two more since US2, both for wallets that may have no record: a holder (a policy
    // without accreditation lets shares reach anyone — the cabinet must still name the
    // company) and a viewer of one of its offers (the market names what is on sale).
    // `offers` here is itself under RLS, so this opens exactly the companies whose
    // offers the wallet may see. No cycle: `holdings` and `offers` policies never read
    // `companies`, and `caprail_admits` reads as its owner.
    apiSelect(
      'companies',
      sql`${t.companyId} = ${scopedCompanyId} OR ${t.admin} = ${scopedWallet} OR ${t.complianceOfficer} = ${scopedWallet} OR EXISTS (SELECT 1 FROM investors i WHERE i.company_id = ${t.companyId} AND i.wallet = ${scopedWallet}) OR EXISTS (SELECT 1 FROM holdings h WHERE h.company_id = ${t.companyId} AND h.wallet = ${scopedWallet} AND h.amount > 0) OR EXISTS (SELECT 1 FROM offers o WHERE o.company_id = ${t.companyId})`,
    ),
  ],
)

// Rows of a company visible through `companies`: whoever can see the company can see
// these. Members see the token and its policy; investors need both for their cabinet.
const memberVisible = (companyId: AnyPgColumn) =>
  sql`${companyId} = ${scopedCompanyId} OR ${companyId} IN (SELECT c.company_id FROM companies c)`

// Mirror of `TokenConfig` plus the metadata from `TokenCreated`. A company may issue
// more than one token (FR-018); the policy columns hold the current version, the
// history is `policy_versions`.
export const tokens = pgTable(
  'tokens',
  {
    mint: text('mint').primaryKey(),
    companyId: u64('company_id')
      .notNull()
      .references(() => companies.companyId),
    treasury: text('treasury').notNull(),
    name: text('name').notNull(),
    symbol: text('symbol').notNull(),
    decimals: smallint('decimals').notNull(),
    totalSupply: u64('total_supply').notNull(),
    requireAccreditation: boolean('require_accreditation').notNull(),
    requireRofr: boolean('require_rofr').notNull(),
    rofrWindowSecs: integer('rofr_window_secs').notNull(),
    policyVersion: integer('policy_version').notNull(),
    createdSignature: text('created_signature').notNull(),
    createdSlot: bigint('created_slot', { mode: 'bigint' }).notNull(),
    createdAt: unixTime('created_at'),
    updatedAt: unixTime('updated_at').notNull(),
  },
  (t) => [
    index('tokens_company_id_idx').on(t.companyId),
    denyAll('tokens'),
    apiSelect('tokens', memberVisible(t.companyId)),
  ],
)

// History of `TransferPolicy` per mint: version 1 from `TokenCreated`, the rest from
// `PolicySet`. `set_at` is the event's own clock (null for version 1 — block time
// is the only clock `TokenCreated` has).
export const policyVersions = pgTable(
  'policy_versions',
  {
    mint: text('mint')
      .notNull()
      .references(() => tokens.mint),
    version: integer('version').notNull(),
    companyId: u64('company_id')
      .notNull()
      .references(() => companies.companyId),
    requireAccreditation: boolean('require_accreditation').notNull(),
    requireRofr: boolean('require_rofr').notNull(),
    rofrWindowSecs: integer('rofr_window_secs').notNull(),
    setAt: unixTime('set_at'),
    txSignature: text('tx_signature').notNull(),
    slot: bigint('slot', { mode: 'bigint' }).notNull(),
    blockTime: unixTime('block_time'),
  },
  (t) => [
    primaryKey({ columns: [t.mint, t.version] }),
    denyAll('policy_versions'),
    apiSelect('policy_versions', memberVisible(t.companyId)),
  ],
)

// Mirror of `InvestorRecord`, one row per (mint, wallet), always the latest
// `InvestorStatusSet`. `jurisdiction` is null where the chain holds [0, 0].
export const investors = pgTable(
  'investors',
  {
    mint: text('mint')
      .notNull()
      .references(() => tokens.mint),
    wallet: text('wallet').notNull(),
    companyId: u64('company_id')
      .notNull()
      .references(() => companies.companyId),
    status: investorStatus('status').notNull(),
    expiresAt: unixTime('expires_at').notNull(),
    jurisdiction: text('jurisdiction'),
    investorType: smallint('investor_type').notNull(),
    updatedAt: unixTime('updated_at').notNull(),
    updatedBy: text('updated_by').notNull(),
    txSignature: text('tx_signature').notNull(),
    slot: bigint('slot', { mode: 'bigint' }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.mint, t.wallet] }),
    index('investors_company_id_idx').on(t.companyId),
    // Membership lookup at sign-in: which registries hold this wallet.
    index('investors_wallet_idx').on(t.wallet),
    check('investors_jurisdiction_iso2', sql`${t.jurisdiction} ~ '^[A-Z]{2}$'`),
    denyAll('investors'),
    apiSelect(
      'investors',
      sql`${t.companyId} = ${scopedCompanyId} OR ${t.wallet} = ${scopedWallet}`,
    ),
  ],
)

// Every `InvestorStatusSet`, in order — the registry's audit trail (FR-002 reports).
// (tx_signature, event_index) is what makes a replayed transaction a no-op across
// worker restarts.
export const investorStatusEvents = pgTable(
  'investor_status_events',
  {
    id: bigint('id', { mode: 'bigint' }).primaryKey().generatedAlwaysAsIdentity(),
    mint: text('mint')
      .notNull()
      .references(() => tokens.mint),
    wallet: text('wallet').notNull(),
    companyId: u64('company_id')
      .notNull()
      .references(() => companies.companyId),
    status: investorStatus('status').notNull(),
    expiresAt: unixTime('expires_at').notNull(),
    jurisdiction: text('jurisdiction'),
    investorType: smallint('investor_type').notNull(),
    setAt: unixTime('set_at').notNull(),
    setBy: text('set_by').notNull(),
    txSignature: text('tx_signature').notNull(),
    eventIndex: integer('event_index').notNull(),
    slot: bigint('slot', { mode: 'bigint' }).notNull(),
    blockTime: unixTime('block_time'),
  },
  (t) => [
    uniqueIndex('investor_status_events_tx_idx').on(t.txSignature, t.eventIndex),
    index('investor_status_events_wallet_idx').on(t.mint, t.wallet, t.setAt),
    denyAll('investor_status_events'),
    apiSelect(
      'investor_status_events',
      sql`${t.companyId} = ${scopedCompanyId} OR ${t.wallet} = ${scopedWallet}`,
    ),
  ],
)

// The journal (FR-008): every transfer the hook saw, allowed or rejected, plus the
// panel's refused simulations. A rejection the worker reads from a failed transaction
// has no event, so the parties and the amount are what T027 can recover from the
// instruction — nullable; the mint is not, a row that cannot be placed is not written.
export const transferAttempts = pgTable(
  'transfer_attempts',
  {
    id: bigint('id', { mode: 'bigint' }).primaryKey().generatedAlwaysAsIdentity(),
    mint: text('mint')
      .notNull()
      .references(() => tokens.mint),
    companyId: u64('company_id')
      .notNull()
      .references(() => companies.companyId),
    sourceOwner: text('source_owner'),
    destOwner: text('dest_owner'),
    amount: u64('amount'),
    outcome: attemptOutcome('outcome').notNull(),
    reasonCode: text('reason_code'),
    origin: attemptOrigin('origin').notNull(),
    fromTreasury: boolean('from_treasury').notNull().default(false),
    policyVersion: integer('policy_version'),
    txSignature: text('tx_signature'),
    eventIndex: integer('event_index').notNull().default(0),
    slot: bigint('slot', { mode: 'bigint' }),
    blockTime: unixTime('block_time').notNull(),
    logs: text('logs').array().notNull(),
    // The session that reported a simulation; null for chain rows.
    reportedBy: text('reported_by'),
    createdAt: unixTime('created_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('transfer_attempts_tx_idx')
      .on(t.txSignature, t.eventIndex)
      .where(sql`${t.txSignature} IS NOT NULL`),
    // Journal pages by company, newest first; `id` breaks ties for the cursor.
    index('transfer_attempts_journal_idx').on(t.companyId, t.blockTime, t.id),
    index('transfer_attempts_mint_idx').on(t.mint, t.blockTime),
    check(
      'transfer_attempts_reason_matches_outcome',
      sql`(${t.outcome} = 'allowed') = (${t.reasonCode} IS NULL)`,
    ),
    check(
      'transfer_attempts_chain_has_signature',
      sql`(${t.origin} = 'chain') = (${t.txSignature} IS NOT NULL)`,
    ),
    // ~600 B per row is the free-tier budget in PLAN; the panel keeps 20 lines.
    check('transfer_attempts_logs_bounded', sql`cardinality(${t.logs}) <= 20`),
    denyAll('transfer_attempts'),
    apiSelect(
      'transfer_attempts',
      // `reported_by` is here for the INSERT's RETURNING: a row the reporter could not
      // read back would make the insert fail under RLS.
      sql`${t.companyId} = ${scopedCompanyId} OR ${t.sourceOwner} = ${scopedWallet} OR ${t.destOwner} = ${scopedWallet} OR ${t.reportedBy} = ${scopedWallet}`,
    ),
    // The only thing the API writes as `caprail_api`: a simulation report from a
    // signed-in wallet. Chain rows come from the worker, outside RLS.
    pgPolicy('transfer_attempts_api_insert', {
      for: 'insert',
      to: apiRole,
      withCheck: sql`${t.origin} = 'simulation' AND ${t.reportedBy} = ${scopedWallet}`,
    }),
  ],
)

// Current balance per (mint, wallet), advanced by `TransferAllowed`; the treasury has
// a row like any holder. `distributed` accumulates what arrived from the treasury —
// the `distribution` source of FR-007 — and `verified_at` marks the last time the
// amount was checked against `getTokenAccountBalance`.
export const holdings = pgTable(
  'holdings',
  {
    mint: text('mint')
      .notNull()
      .references(() => tokens.mint),
    wallet: text('wallet').notNull(),
    companyId: u64('company_id')
      .notNull()
      .references(() => companies.companyId),
    amount: u64('amount').notNull(),
    distributed: u64('distributed').notNull().default(sql`0`),
    lastSignature: text('last_signature').notNull(),
    lastSlot: bigint('last_slot', { mode: 'bigint' }).notNull(),
    updatedAt: unixTime('updated_at').notNull(),
    verifiedAt: unixTime('verified_at'),
  },
  (t) => [
    primaryKey({ columns: [t.mint, t.wallet] }),
    index('holdings_company_id_idx').on(t.companyId),
    check('holdings_amount_non_negative', sql`${t.amount} >= 0`),
    denyAll('holdings'),
    apiSelect(
      'holdings',
      sql`${t.companyId} = ${scopedCompanyId} OR ${t.wallet} = ${scopedWallet}`,
    ),
  ],
)

// ── Index of the market (US2) ─────────────────────────────────────────────────────

// Mirror of `Offer`, keyed by its PDA (the account is never closed, so the address
// is never reused). The terms come from `OfferCreated`; `remaining`, `status` and
// `closed_at` from `OfferAccepted`/`OfferCancelled`.
//
// The rest is what the events cannot say. The offer is a delegation, not escrow, so
// the seller can revoke it, spend the shares or be frozen without our program
// seeing it (PLAN → risk 6). `available` is how much of `remaining` the seller's
// account can deliver as last read, and `stale_reason` names why that is less
// than `remaining` (null: all of it). The worker re-reads open offers whose
// `checked_at` is null or older than 30 s; `touched_slot` is the last slot at which
// the chain changed something the reading depends on, so a read from before it is
// discarded instead of written.
export const offers = pgTable(
  'offers',
  {
    offer: text('offer').primaryKey(),
    mint: text('mint')
      .notNull()
      .references(() => tokens.mint),
    companyId: u64('company_id')
      .notNull()
      .references(() => companies.companyId),
    seller: text('seller').notNull(),
    offerId: u64('offer_id').notNull(),
    amount: u64('amount').notNull(),
    remaining: u64('remaining').notNull(),
    pricePerUnit: u64('price_per_unit').notNull(),
    paymentMint: text('payment_mint').notNull(),
    // null where the chain holds 0: no ROFR window was opened.
    rofrUntil: unixTime('rofr_until'),
    status: offerStatus('status').notNull(),
    createdAt: unixTime('created_at').notNull(),
    createdSignature: text('created_signature').notNull(),
    createdSlot: bigint('created_slot', { mode: 'bigint' }).notNull(),
    // `cancelled_at`, or `accepted_at` of the trade that filled it.
    closedAt: unixTime('closed_at'),
    // From `OfferCancelled`: false when the delegation was no longer this offer's.
    delegationRevoked: boolean('delegation_revoked'),
    updatedAt: unixTime('updated_at').notNull(),
    touchedSlot: bigint('touched_slot', { mode: 'bigint' }).notNull(),
    available: u64('available'),
    staleReason: offerStaleReason('stale_reason'),
    checkedAt: unixTime('checked_at'),
    checkedSlot: bigint('checked_slot', { mode: 'bigint' }),
  },
  (t) => [
    // The PDA seeds; seller first — the cabinet (`/me`) lists a wallet's own offers.
    uniqueIndex('offers_seller_idx').on(t.seller, t.mint, t.offerId),
    index('offers_mint_status_idx').on(t.mint, t.status),
    index('offers_company_id_idx').on(t.companyId),
    // The stale sweep: open offers, least recently checked first.
    index('offers_open_checked_idx').on(t.checkedAt).where(sql`${t.status} = 'open'`),
    check('offers_remaining_bounded', sql`${t.remaining} <= ${t.amount}`),
    // Only an open offer can be cancelled, and an open offer has something left.
    check('offers_filled_means_zero', sql`(${t.status} = 'filled') = (${t.remaining} = 0)`),
    check(
      'offers_executability_only_when_open',
      sql`${t.status} = 'open' OR (${t.available} IS NULL AND ${t.staleReason} IS NULL)`,
    ),
    check(
      'offers_stale_means_short',
      sql`${t.available} IS NULL OR (${t.available} <= ${t.remaining} AND (${t.staleReason} IS NULL) = (${t.available} = ${t.remaining}))`,
    ),
    denyAll('offers'),
    // The company sees its book, a seller their own offers.
    apiSelect('offers', sql`${t.companyId} = ${scopedCompanyId} OR ${t.seller} = ${scopedWallet}`),
    // Everyone else sees an open offer only while the hook would let the shares reach
    // them (FR-011). The check needs `tokens` and `investors` rows the wallet may not
    // see — a policy without accreditation admits wallets with no record — so it is a
    // SECURITY DEFINER function (migration 0004, by hand: drizzle-kit does not model
    // functions); `GET /market/offers` calls the same function with the API's clock.
    pgPolicy('offers_market_select', {
      for: 'select',
      to: apiRole,
      using: sql`${t.status} = 'open' AND ${admitsSql(t.mint, scopedWallet, sql`now()`)}`,
    }),
  ],
)

// One row per `OfferAccepted`. The share transfer of the same trade is also a
// `transfer_attempts` row (the hook's `TransferAllowed`); this is the money side.
// `payment` is what the buyer paid; the seller received `payment - fee`.
export const trades = pgTable(
  'trades',
  {
    txSignature: text('tx_signature').notNull(),
    eventIndex: integer('event_index').notNull(),
    offer: text('offer')
      .notNull()
      .references(() => offers.offer),
    mint: text('mint')
      .notNull()
      .references(() => tokens.mint),
    companyId: u64('company_id')
      .notNull()
      .references(() => companies.companyId),
    seller: text('seller').notNull(),
    buyer: text('buyer').notNull(),
    offerId: u64('offer_id').notNull(),
    amount: u64('amount').notNull(),
    pricePerUnit: u64('price_per_unit').notNull(),
    payment: u64('payment').notNull(),
    fee: u64('fee').notNull(),
    paymentMint: text('payment_mint').notNull(),
    // The offer's `remaining` after this trade.
    remaining: u64('remaining').notNull(),
    acceptedAt: unixTime('accepted_at').notNull(),
    slot: bigint('slot', { mode: 'bigint' }).notNull(),
    blockTime: unixTime('block_time').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.txSignature, t.eventIndex] }),
    index('trades_mint_idx').on(t.mint, t.blockTime),
    index('trades_company_id_idx').on(t.companyId, t.blockTime),
    index('trades_offer_idx').on(t.offer),
    index('trades_buyer_idx').on(t.buyer),
    index('trades_seller_idx').on(t.seller),
    check('trades_fee_within_payment', sql`${t.fee} <= ${t.payment}`),
    denyAll('trades'),
    apiSelect(
      'trades',
      sql`${t.companyId} = ${scopedCompanyId} OR ${t.buyer} = ${scopedWallet} OR ${t.seller} = ${scopedWallet}`,
    ),
  ],
)
