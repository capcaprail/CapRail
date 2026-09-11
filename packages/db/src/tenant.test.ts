import { walletAddressSchema } from '@caprail/shared'
import type { SQL } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import { describe, expect, it } from 'vitest'
import type { Db, Tx } from './client.ts'
import { API_ROLE_SQL, type TenantScope, tenantSettings, withTenant } from './tenant.ts'

const WALLET = walletAddressSchema.parse('As8C4JwSGHd7HPvh5KD1FhhLsQphQ8veSdhipiSRWs7g')
// The u64 `company_id` as the API and the JWT carry it.
const COMPANY = '7'

function fakeDb(executed: SQL[]): Db {
  const tx = {
    execute: (query: SQL) => {
      executed.push(query)
      return Promise.resolve([])
    },
  } as unknown as Tx
  return { transaction: <T>(fn: (tx: Tx) => Promise<T>) => fn(tx) } as unknown as Db
}

const render = (query: SQL) => new PgDialect().sqlToQuery(query)

describe('tenantSettings', () => {
  it('maps the scope onto both app.* settings', () => {
    expect(tenantSettings({ companyId: COMPANY, wallet: WALLET })).toEqual([
      ['app.company_id', COMPANY],
      ['app.wallet', WALLET],
    ])
  })

  it('writes an empty string for a missing dimension so policies match nothing', () => {
    expect(tenantSettings({ wallet: WALLET })).toEqual([
      ['app.company_id', ''],
      ['app.wallet', WALLET],
    ])
    expect(tenantSettings({})).toEqual([
      ['app.company_id', ''],
      ['app.wallet', ''],
    ])
  })
})

describe('withTenant', () => {
  it('assumes the api role first, then sets both settings, all before the callback', async () => {
    const executed: SQL[] = []
    const order: string[] = []
    const result = await withTenant(
      fakeDb(executed),
      { companyId: COMPANY, wallet: WALLET },
      () => {
        order.push('callback')
        return Promise.resolve(42)
      },
    )
    expect(result).toBe(42)
    expect(executed).toHaveLength(3)
    const [role, ...settings] = executed.map(render)
    // The owner role bypasses RLS; the policies only bind once the transaction runs
    // as `caprail_api`, and LOCAL is what undoes it before the pooler reuses the socket.
    expect(role).toEqual({ sql: 'set local role "caprail_api"', params: [] })
    expect(role?.sql).toBe(API_ROLE_SQL)
    for (const { sql, params } of settings) {
      expect(sql).toMatch(/set_config\(\$1, \$2, true\)/)
      expect(params).toHaveLength(2)
    }
    expect(settings[0]?.params).toEqual(['app.company_id', COMPANY])
    expect(settings[1]?.params).toEqual(['app.wallet', WALLET])
    expect(order).toEqual(['callback'])
  })

  it('never interpolates the scope into the SQL text', async () => {
    const executed: SQL[] = []
    const scope: TenantScope = { companyId: "x'; drop table companies; --" }
    await withTenant(fakeDb(executed), scope, () => Promise.resolve())
    for (const query of executed) expect(render(query).sql).not.toContain('drop table')
  })
})
