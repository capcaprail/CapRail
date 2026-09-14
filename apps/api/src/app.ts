import { Hono } from 'hono'
import { cors } from 'hono/cors'
import type { AppEnv } from './env.ts'
import type { Feed } from './index/feed.ts'
import type { IndexReader } from './index/reader.ts'
import { type Logger, requestLogger } from './logger.ts'
import { requireCompanyRole, requireSession } from './middleware/auth.ts'
import { errorHandler, notFoundHandler } from './middleware/errors.ts'
import { type RateLimitOptions, rateLimit } from './middleware/rate-limit.ts'
import { attemptsRoute } from './routes/attempts.ts'
import { type AuthDeps, authRoute } from './routes/auth.ts'
import { companiesRoute, PANEL_ROLES } from './routes/companies.ts'
import { eventsRoute } from './routes/events.ts'
import { type HealthDeps, healthRoute } from './routes/health.ts'

export type AppDeps = {
  logger: Logger
  webOrigins: string[]
  health: HealthDeps
  auth: AuthDeps
  // The index as the session may see it; `feed` polls it for the SSE stream.
  reader: IndexReader
  feed: Feed
  rateLimit?: RateLimitOptions
  now?: () => Date
  heartbeatMs?: number
}

// Dependencies come in as an argument: /health is testable without a database, the
// limiter without waiting a minute.
export function createApp(deps: AppDeps) {
  const app = new Hono<AppEnv>()

  app.use('*', requestLogger(deps.logger))
  app.use('*', cors({ origin: deps.webOrigins, allowHeaders: ['Authorization', 'Content-Type'] }))
  // Only the paths an unauthenticated or cheap client writes to (PLAN → API);
  // /health stays outside so the Railway probe is never throttled by us.
  const limiter = rateLimit(deps.rateLimit)
  app.use('/auth/*', limiter)
  app.use('/attempts', limiter)

  // Company routes: a session, then a panel role in that company, re-checked against
  // the index on every request so `set_roles` takes effect before the token expires.
  app.use('/companies/:id', requireSession(deps.auth.tokens))
  app.use('/companies/:id', requireCompanyRole(deps.reader.rolesOf, PANEL_ROLES))
  app.use('/companies/:id/*', requireSession(deps.auth.tokens))
  app.use('/companies/:id/*', requireCompanyRole(deps.reader.rolesOf, PANEL_ROLES))
  app.use('/attempts', requireSession(deps.auth.tokens))

  app.notFound(notFoundHandler)
  app.onError(errorHandler)

  const timed = deps.now === undefined ? {} : { now: deps.now }
  return app
    .route('/', healthRoute(deps.health))
    .route('/', authRoute(deps.auth))
    .route('/', companiesRoute({ reader: deps.reader, ...timed }))
    .route(
      '/',
      eventsRoute({
        feed: deps.feed,
        ...(deps.heartbeatMs === undefined ? {} : { heartbeatMs: deps.heartbeatMs }),
      }),
    )
    .route('/', attemptsRoute({ reader: deps.reader, ...timed }))
}

export type App = ReturnType<typeof createApp>
