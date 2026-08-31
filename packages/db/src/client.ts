import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema.ts'

// Supabase free tier: a handful of pooled connections shared by api and worker. An
// in-process queue beats a refused connection in the neighbouring service.
export const POOL_MAX = 3
const IDLE_TIMEOUT_SECONDS = 20
const CONNECT_TIMEOUT_SECONDS = 10

export type Db = PostgresJsDatabase<typeof schema>
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]

export type DbHandle = {
  db: Db
  sql: postgres.Sql
  ping: () => Promise<void>
  close: () => Promise<void>
}

export function createDb(databaseUrl: string): DbHandle {
  if (databaseUrl === '') throw new Error('DATABASE_URL is empty')
  // pgbouncer in transaction mode hands the connection to another client between
  // queries, so a PREPARE made in one query does not exist in the next; the failure
  // shows up as `prepared statement "s1" does not exist` on a random query under load.
  const sql = postgres(databaseUrl, {
    prepare: false,
    max: POOL_MAX,
    idle_timeout: IDLE_TIMEOUT_SECONDS,
    connect_timeout: CONNECT_TIMEOUT_SECONDS,
  })
  return {
    db: drizzle(sql, { schema }),
    sql,
    ping: async () => {
      await sql`select 1`
    },
    close: () => sql.end({ timeout: 5 }),
  }
}
