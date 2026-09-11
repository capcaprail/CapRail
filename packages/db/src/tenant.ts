import type { WalletAddress } from '@caprail/shared'
import { sql } from 'drizzle-orm'
import type { Db, Tx } from './client.ts'
import { apiRole } from './schema.ts'

export type TenantScope = {
  // The u64 `company_id` as a decimal string — the same value as `/companies/:id`
  // and the JWT membership. Set only for a session that holds a role in that company;
  // an investor session carries the wallet alone.
  companyId?: string
  wallet?: WalletAddress
}

// Both settings are always written: RLS policies read `current_setting(name, true)`,
// and '' matches no row, so a dimension absent from the session cannot inherit a
// value from whatever ran on this pooled connection before.
export function tenantSettings(scope: TenantScope): [name: string, value: string][] {
  return [
    ['app.company_id', scope.companyId ?? ''],
    ['app.wallet', scope.wallet ?? ''],
  ]
}

// The connection is `postgres`, which owns the tables and has BYPASSRLS: policies
// never apply to it. Switching to `caprail_api` for the transaction is what makes them
// apply; `SET LOCAL` reverts at COMMIT/ROLLBACK, before the pooler hands the
// connection on. The role name is an identifier, not a value, hence not a parameter.
export const API_ROLE_SQL = `set local role "${apiRole.name}"`

// `SET LOCAL` takes no bind parameters; `set_config(name, value, true)` is the same
// transaction-local assignment and keeps the scope out of the SQL text.
export function withTenant<T>(db: Db, scope: TenantScope, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql.raw(API_ROLE_SQL))
    for (const [name, value] of tenantSettings(scope)) {
      await tx.execute(sql`select set_config(${name}, ${value}, true)`)
    }
    return fn(tx)
  })
}
