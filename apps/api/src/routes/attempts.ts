import { type AttemptReportResponse, attemptReportSchema } from '@caprail/shared'
import { Hono } from 'hono'
import type { AppEnv } from '../env.ts'
import type { IndexReader } from '../index/reader.ts'
import { fail } from '../middleware/errors.ts'
import { validate } from '../middleware/validate.ts'

export type AttemptsDeps = {
  reader: Pick<IndexReader, 'reportAttempt'>
  now?: () => Date
}

// `POST /attempts`: the panel's wallet simulated a transfer, the hook refused it in
// preflight, nothing reached the chain — the journal still shows it, marked
// `simulation` (PLAN → risk 2). Any session may report; RLS decides whether the
// reporter can see the mint (a company member or an investor of it), and the row
// carries `reported_by`. Rate limited in `app.ts`, mounted behind `requireSession`.
export function attemptsRoute(deps: AttemptsDeps): Hono<AppEnv> {
  const now = deps.now ?? (() => new Date())

  return new Hono<AppEnv>().post('/attempts', validate('json', attemptReportSchema), async (c) => {
    const wallet = c.get('session').wallet
    const report = c.req.valid('json')
    const inserted = await deps.reader.reportAttempt({ wallet }, report, wallet, now())
    if (inserted === null) return fail(c, 'NOT_FOUND', 'mint is not indexed or not visible to you')
    c.get('logger').info(
      { wallet, mint: report.mint, reason: report.reasonCode },
      'simulation refusal reported',
    )
    const body: AttemptReportResponse = { id: inserted.id.toString() }
    return c.json(body, 201)
  })
}
