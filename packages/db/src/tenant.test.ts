import { walletAddressSchema } from '@caprail/shared'
import type { SQL } from 'drizzle-orm'
import { PgDialect } from 'drizzle-orm/pg-core'
import { describe, expect, it } from 'vitest'
import type { Db, Tx } from './client.ts'
import { type TenantScope, tenantSettings, withTenant } from './tenant.ts'

const WALLET = walletAddressSchema.parse('As8C4JwSGHd7HPvh5KD1FhhLsQphQ8veSdhipiSRWs7g')
const COMPANY = 'a8a4KNjnNoSsDvYuKAuFptgt471FtC3UsrYT3sT5Mm4'

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
  it('sets both settings transaction-locally before the callback, values as parameters', async () => {
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
    expect(executed).toHaveLength(2)
    for (const query of executed) {
      const { sql, params } = render(query)
      expect(sql).toMatch(/set_config\(\$1, \$2, true\)/)
      expect(params).toHaveLength(2)
    }
    expect(render(executed[0] as SQL).params).toEqual(['app.company_id', COMPANY])
    expect(render(executed[1] as SQL).params).toEqual(['app.wallet', WALLET])
    expect(order).toEqual(['callback'])
  })

  it('never interpolates the scope into the SQL text', async () => {
    const executed: SQL[] = []
    const scope: TenantScope = { companyId: "x'; drop table companies; --" }
    await withTenant(fakeDb(executed), scope, () => Promise.resolve())
    for (const query of executed) expect(render(query).sql).not.toContain('drop table')
  })
})
