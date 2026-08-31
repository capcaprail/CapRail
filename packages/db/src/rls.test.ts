import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getTableName, is } from 'drizzle-orm'
import { PgTable } from 'drizzle-orm/pg-core'
import { describe, expect, it } from 'vitest'
import * as schema from './schema.ts'

// Table list comes from the schema, not from a constant: a table added without RLS
// must break the gate rather than reach Supabase open to anon.
const migrations = join(dirname(fileURLToPath(import.meta.url)), '../migrations')

const sql = readdirSync(migrations)
  .filter((file) => file.endsWith('.sql'))
  .sort()
  .map((file) => readFileSync(join(migrations, file), 'utf8'))
  .join('\n')

const tables = (Object.values(schema) as unknown[])
  .filter((value): value is PgTable => is(value, PgTable))
  .map(getTableName)
  .sort()

describe('migrations', () => {
  it('cover the foundation tables', () => {
    expect(tables).toEqual(['auth_nonces', 'indexer_cursor'])
    for (const table of tables) expect(sql, table).toContain(`CREATE TABLE "${table}"`)
  })

  it('enable RLS and deny anon/authenticated on every table', () => {
    for (const table of tables) {
      expect(sql, table).toContain(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY;`)
      expect(sql, table).toContain(
        `CREATE POLICY "${table}_deny_all" ON "${table}" ` +
          'AS RESTRICTIVE FOR ALL TO "anon", "authenticated" ' +
          'USING (false) WITH CHECK (false);',
      )
    }
  })
})
