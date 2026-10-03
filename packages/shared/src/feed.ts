import { z } from 'zod'
import {
  investorViewSchema,
  isoTimeSchema,
  journalEntrySchema,
  transferPolicySchema,
} from './company-api.ts'
import { offerRecordSchema } from './market.ts'

// SSE `/companies/:id/events`: one of these per message, the event name is `kind`.
// Its own module because it spans the company reads and the market.
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
  // An offer of the company was posted, traded, cancelled, or its seller's account
  // changed what can be taken (T039's reading). The record has no quote — that needs
  // the platform, which the book read carries.
  z.object({ kind: z.literal('offer'), offer: offerRecordSchema }),
])
export type FeedEvent = z.infer<typeof feedEventSchema>
