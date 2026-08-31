import { sql } from 'drizzle-orm'
import { bigint, pgPolicy, pgTable, text, timestamp } from 'drizzle-orm/pg-core'
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
