import { z } from 'zod'
import { walletAddressSchema } from './primitives.ts'
import { rejectionReasonSchema } from './reasons.ts'

// Read models of the index as the API serves them (PLAN → API-контракти). u64
// amounts travel as decimal strings — JSON numbers stop at 2^53 — and times as ISO
// strings. The panel parses responses with these same schemas.

export const u64StringSchema = z.string().regex(/^\d{1,20}$/, 'expected a u64 as a decimal string')

// The u64 `company_id` as a decimal string: the tenant key of every company route.
export const companyIdSchema = u64StringSchema

export const isoTimeSchema = z.iso.datetime({ offset: true })

export const transferPolicySchema = z.object({
  requireAccreditation: z.boolean(),
  requireRofr: z.boolean(),
  rofrWindowSecs: z.number().int().nonnegative(),
})
export type TransferPolicy = z.infer<typeof transferPolicySchema>

export const tokenViewSchema = z.object({
  mint: z.string().min(1),
  treasury: z.string().min(1),
  name: z.string(),
  symbol: z.string(),
  decimals: z.number().int().min(0),
  totalSupply: u64StringSchema,
  policy: transferPolicySchema,
  policyVersion: z.number().int().positive(),
  createdAt: isoTimeSchema.nullable(),
})
export type TokenView = z.infer<typeof tokenViewSchema>

export const companyViewSchema = z.object({
  companyId: companyIdSchema,
  company: z.string().min(1),
  name: z.string(),
  admin: walletAddressSchema,
  complianceOfficer: walletAddressSchema,
  rolesSetAt: isoTimeSchema.nullable(),
  // A company may issue more than one token (FR-018); oldest first.
  tokens: z.array(tokenViewSchema),
})
export type CompanyView = z.infer<typeof companyViewSchema>

// Names match the on-chain enum (`InvestorStatus`) in its declaration order; the
// program, the index and the API all spell them this way.
export const INVESTOR_STATUSES = ['none', 'approved', 'revoked'] as const
export const investorStatusSchema = z.enum(INVESTOR_STATUSES)
export type InvestorStatus = z.infer<typeof investorStatusSchema>

export const investorViewSchema = z.object({
  mint: z.string().min(1),
  wallet: walletAddressSchema,
  status: investorStatusSchema,
  expiresAt: isoTimeSchema,
  jurisdiction: z.string().length(2).nullable(),
  investorType: z.number().int(),
  updatedAt: isoTimeSchema,
  updatedBy: walletAddressSchema,
})
export type InvestorView = z.infer<typeof investorViewSchema>

// Where a holder's amount came from. Only `distribution` exists in US1; `grant`
// and `purchase` arrive with US3/US2 and the shape is fixed now.
export const HOLDING_SOURCES = ['distribution', 'grant', 'purchase'] as const
export const holdingSourceSchema = z.object({
  kind: z.enum(HOLDING_SOURCES),
  amount: u64StringSchema,
})

export const holderSchema = z.object({
  wallet: walletAddressSchema,
  amount: u64StringSchema,
  // Share of `totalSupply`, in percent, two decimals.
  pct: z.number().min(0).max(100),
  vested: u64StringSchema,
  unvested: u64StringSchema,
  sources: z.array(holdingSourceSchema),
})
export type Holder = z.infer<typeof holderSchema>

export const capTableSchema = z.object({
  mint: z.string().min(1),
  at: isoTimeSchema,
  totalSupply: u64StringSchema,
  // What the treasury still holds — issued but not distributed; not a holder row.
  treasury: u64StringSchema,
  holders: z.array(holderSchema),
})
export type CapTable = z.infer<typeof capTableSchema>

export const ATTEMPT_OUTCOMES = ['allowed', 'rejected'] as const
export type AttemptOutcome = (typeof ATTEMPT_OUTCOMES)[number]
// `chain` rows come from the worker; `simulation` rows from `POST /attempts`.
export const ATTEMPT_ORIGINS = ['chain', 'simulation'] as const
export type AttemptOrigin = (typeof ATTEMPT_ORIGINS)[number]

export const journalEntrySchema = z.object({
  id: z.string().regex(/^\d+$/),
  mint: z.string().min(1),
  sourceOwner: z.string().nullable(),
  destOwner: z.string().nullable(),
  amount: u64StringSchema.nullable(),
  outcome: z.enum(ATTEMPT_OUTCOMES),
  // A `CaprailError` variant name; null when allowed.
  reasonCode: z.string().nullable(),
  origin: z.enum(ATTEMPT_ORIGINS),
  fromTreasury: z.boolean(),
  policyVersion: z.number().int().nullable(),
  txSignature: z.string().nullable(),
  slot: z.number().int().nullable(),
  blockTime: isoTimeSchema,
  logs: z.array(z.string()),
})
export type JournalEntry = z.infer<typeof journalEntrySchema>

export const journalPageSchema = z.object({
  items: z.array(journalEntrySchema),
  // Opaque; pass back as `?cursor=` for the next (older) page.
  nextCursor: z.string().nullable(),
})
export type JournalPage = z.infer<typeof journalPageSchema>

export const JOURNAL_PAGE_SIZE = 50
export const JOURNAL_PAGE_MAX = 200

export const journalQuerySchema = z.object({
  mint: z.string().min(1).optional(),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(JOURNAL_PAGE_MAX).prefault(JOURNAL_PAGE_SIZE),
  from: isoTimeSchema.optional(),
  to: isoTimeSchema.optional(),
})
export type JournalQuery = z.infer<typeof journalQuerySchema>

export const capTableQuerySchema = z.object({ mint: z.string().min(1).optional() })

// A refused simulation reported by the panel (PLAN → risk 2): the wallet's
// preflight said no, nothing reached the chain, but the journal must still show
// it. The logs are the simulation's; the schema bounds them like the column does.
export const ATTEMPT_LOG_LINES = 20
export const ATTEMPT_LOG_LINE_LENGTH = 1_000

export const attemptReportSchema = z.object({
  mint: z.string().min(1),
  sourceOwner: walletAddressSchema,
  destOwner: walletAddressSchema,
  amount: u64StringSchema,
  reasonCode: rejectionReasonSchema,
  logs: z.array(z.string().max(ATTEMPT_LOG_LINE_LENGTH)).max(ATTEMPT_LOG_LINES),
})
export type AttemptReport = z.infer<typeof attemptReportSchema>

export const attemptReportResponseSchema = z.object({ id: z.string().regex(/^\d+$/) })
export type AttemptReportResponse = z.infer<typeof attemptReportResponseSchema>

// SSE `/companies/:id/events`: one of these per message, the event name is `kind`.
export const feedEventSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('attempt'), entry: journalEntrySchema }),
  z.object({ kind: z.literal('status'), investor: investorViewSchema }),
  z.object({
    kind: z.literal('policy'),
    mint: z.string().min(1),
    policy: transferPolicySchema,
    policyVersion: z.number().int().positive(),
    setAt: isoTimeSchema.nullable(),
  }),
])
export type FeedEvent = z.infer<typeof feedEventSchema>
