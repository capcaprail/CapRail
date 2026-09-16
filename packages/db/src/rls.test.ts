import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getTableName, is } from 'drizzle-orm'
import { PgTable } from 'drizzle-orm/pg-core'
import { describe, expect, it } from 'vitest'
import * as schema from './schema.ts'
import { API_ROLE_SQL } from './tenant.ts'

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

// Service tables are read by api/worker as the owner only; everything else is the
// index a session reads through `withTenant`, and each of those needs a policy for
// the api role and a SELECT grant, or the panel sees nothing without an error.
const SERVICE_TABLES = ['auth_nonces', 'indexer_cursor']
const INDEX_TABLES = [
  'companies',
  'holdings',
  'investor_status_events',
  'investors',
  'policy_versions',
  'tokens',
  'transfer_attempts',
]

const policy = (name: string, table: string) =>
  new RegExp(
    `CREATE POLICY "${name}" ON "${table}" AS PERMISSIVE FOR (\\w+) TO "caprail_api" (.*);`,
  )

// The definition in force: the CREATE, or the last ALTER POLICY after it.
const policyInForce = (name: string, table: string): string | undefined =>
  [
    ...sql.matchAll(
      new RegExp(
        `(?:CREATE|ALTER) POLICY "${name}" ON "${table}" (?:AS PERMISSIVE FOR \\w+ )?TO "?caprail_api"? (.*);`,
        'g',
      ),
    ),
  ].at(-1)?.[1]

describe('migrations', () => {
  it('cover every table in the schema', () => {
    expect(tables).toEqual([...SERVICE_TABLES, ...INDEX_TABLES].sort())
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

  it('create the api role, make postgres a member, and grant it the index only', () => {
    expect(sql).toContain('CREATE ROLE "caprail_api";')
    expect(sql).toContain('GRANT "caprail_api" TO "postgres";')
    expect(sql).toContain('GRANT USAGE ON SCHEMA "public" TO "caprail_api";')
    const grant = /GRANT SELECT ON (.*) TO "caprail_api";/.exec(sql)
    const granted = grant?.[1]?.split(', ').map((name) => name.replaceAll('"', ''))
    expect(granted?.sort()).toEqual(INDEX_TABLES)
    for (const table of SERVICE_TABLES) expect(sql).not.toMatch(new RegExp(`GRANT .*"${table}"`))
    // The only write: simulation reports. Identity columns draw from a sequence the
    // role must be allowed to use, or the first POST /attempts fails on nextval.
    expect(sql).toContain('GRANT INSERT ON "transfer_attempts" TO "caprail_api";')
    expect(sql).toContain('GRANT USAGE ON SEQUENCE "transfer_attempts_id_seq" TO "caprail_api";')
    expect(sql).not.toMatch(/GRANT (UPDATE|DELETE|ALL)/)
  })

  it('scope every index table for the api role by app.company_id, the rest by app.wallet', () => {
    const company = `nullif(current_setting('app.company_id', true), '')::numeric`
    const wallet = `nullif(current_setting('app.wallet', true), '')`
    for (const table of INDEX_TABLES) {
      const select = policy(`${table}_api_select`, table).exec(sql)
      expect(select?.[1], table).toBe('SELECT')
      const using = policyInForce(`${table}_api_select`, table) ?? ''
      expect(using, table).toContain(`USING ("${table}"."company_id" = ${company} OR `)
      // Either the wallet itself or membership through `companies` (which is filtered
      // by the same wallet) — never the whole table.
      expect(using, table).toMatch(
        new RegExp(`${wallet.replaceAll(/[()]/g, '\\$&')}|FROM companies c`),
      )
    }
    // Service tables have no api policy at all.
    for (const table of SERVICE_TABLES) expect(sql).not.toContain(`"${table}_api_select"`)
  })

  it('let the api role insert nothing but its own simulation reports', () => {
    const inserts = [...sql.matchAll(/CREATE POLICY "(\w+)" ON "(\w+)" AS PERMISSIVE FOR INSERT/g)]
    expect(inserts.map((m) => m[2])).toEqual(['transfer_attempts'])
    const insert = policy('transfer_attempts_api_insert', 'transfer_attempts').exec(sql)
    expect(insert?.[2]).toBe(
      `WITH CHECK ("transfer_attempts"."origin" = 'simulation' AND "transfer_attempts"."reported_by" = nullif(current_setting('app.wallet', true), ''))`,
    )
    // RETURNING after the insert reads the row back under the SELECT policy.
    expect(sql).toContain(
      `OR "transfer_attempts"."reported_by" = nullif(current_setting('app.wallet', true), '')`,
    )
  })

  it('name the same role in withTenant as the migration creates', () => {
    expect(API_ROLE_SQL).toBe(`set local role "${schema.apiRole.name}"`)
    expect(sql).toContain(`CREATE ROLE "${schema.apiRole.name}";`)
  })

  it('hold the line on replayed transactions with unique signature indexes', () => {
    expect(sql).toContain(
      'CREATE UNIQUE INDEX "investor_status_events_tx_idx" ON "investor_status_events" USING btree ("tx_signature","event_index");',
    )
    expect(sql).toContain(
      'CREATE UNIQUE INDEX "transfer_attempts_tx_idx" ON "transfer_attempts" USING btree ("tx_signature","event_index") WHERE "transfer_attempts"."tx_signature" IS NOT NULL;',
    )
  })
})
