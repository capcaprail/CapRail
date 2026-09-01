import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { type AppEnv, type Logger, requestLogger } from './logger.ts'
import { errorHandler, notFoundHandler } from './middleware/errors.ts'
import { type RateLimitOptions, rateLimit } from './middleware/rate-limit.ts'
import { type HealthDeps, healthRoute } from './routes/health.ts'

export type AppDeps = {
  logger: Logger
  webOrigins: string[]
  health: HealthDeps
  rateLimit?: RateLimitOptions
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

  app.notFound(notFoundHandler)
  app.onError(errorHandler)

  return app.route('/', healthRoute(deps.health))
}

export type App = ReturnType<typeof createApp>
