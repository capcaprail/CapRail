import type { WalletAddress } from '@caprail/shared'
import { sql } from 'drizzle-orm'
import type { Db, Tx } from './client.ts'

export type TenantScope = {
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

// `SET LOCAL` takes no bind parameters; `set_config(name, value, true)` is the same
// transaction-local assignment and keeps the scope out of the SQL text.
export function withTenant<T>(db: Db, scope: TenantScope, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    for (const [name, value] of tenantSettings(scope)) {
      await tx.execute(sql`select set_config(${name}, ${value}, true)`)
    }
    return fn(tx)
  })
}
