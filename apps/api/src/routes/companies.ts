import type { TenantScope } from '@caprail/db'
import {
  type CapTable,
  type CompanyView,
  capTableQuerySchema,
  type InvestorView,
  type JournalPage,
  journalQuerySchema,
  type Role,
} from '@caprail/shared'
import { Hono } from 'hono'
import type { AppEnv } from '../env.ts'
import type { IndexReader } from '../index/reader.ts'
import { fail } from '../middleware/errors.ts'
import { validate } from '../middleware/validate.ts'

// The panel is the company's: the two role keys. An investor's own view is `/me`
// (US2), scoped to the wallet — the cap table and the registry are not theirs.
export const PANEL_ROLES: readonly Role[] = ['admin', 'compliance_officer']

export type CompanyDeps = {
  reader: Pick<IndexReader, 'company' | 'investors' | 'capTable' | 'journal'>
  now?: () => Date
}

// The RLS scope of a panel session: `app.company_id` opens the company's rows,
// `app.wallet` is set as well so a row visible to the wallet alone still shows.
export function panelScope(companyId: string, wallet: TenantScope['wallet']): TenantScope {
  return wallet === undefined ? { companyId } : { companyId, wallet }
}

// Mounted behind `requireSession` + `requireCompanyRole(PANEL_ROLES)` in `app.ts`;
// `:id` is a u64 the middleware already resolved to roles, so a company that is not
// in the index answers 404 here, not in the middleware.
export function companiesRoute(deps: CompanyDeps): Hono<AppEnv> {
  const now = deps.now ?? (() => new Date())

  return new Hono<AppEnv>()
    .get('/companies/:id', async (c) => {
      const id = c.req.param('id')
      const company: CompanyView | null = await deps.reader.company(
        panelScope(id, c.get('session').wallet),
        id,
      )
      if (company === null) return fail(c, 'NOT_FOUND', 'company is not indexed')
      return c.json(company)
    })
    .get('/companies/:id/investors', async (c) => {
      const id = c.req.param('id')
      const investors: InvestorView[] = await deps.reader.investors(
        panelScope(id, c.get('session').wallet),
        id,
      )
      return c.json(investors)
    })
    .get('/companies/:id/cap-table', validate('query', capTableQuerySchema), async (c) => {
      const id = c.req.param('id')
      const { mint } = c.req.valid('query')
      const table: CapTable | null = await deps.reader.capTable(
        panelScope(id, c.get('session').wallet),
        id,
        mint,
        now(),
      )
      if (table === null) {
        return fail(
          c,
          'NOT_FOUND',
          mint === undefined ? 'company has no token yet' : 'no such token in this company',
        )
      }
      return c.json(table)
    })
    .get('/companies/:id/journal', validate('query', journalQuerySchema), async (c) => {
      const id = c.req.param('id')
      const page: JournalPage = await deps.reader.journal(
        panelScope(id, c.get('session').wallet),
        id,
        c.req.valid('query'),
      )
      return c.json(page)
    })
}
