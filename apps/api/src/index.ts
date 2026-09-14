import { createDb, schema } from '@caprail/db'
import { serve } from '@hono/node-server'
import { desc } from 'drizzle-orm'
import { createApp } from './app.ts'
import { createSessionTokens } from './auth/jwt.ts'
import { drizzleNonceStore } from './auth/nonce-store.ts'
import { apiConfigFromEnv } from './config.ts'
import { createFeed } from './index/feed.ts'
import { drizzleIndexReader } from './index/reader.ts'
import { createLogger } from './logger.ts'
import type { IndexerCursor } from './routes/health.ts'

function main(): void {
  const config = apiConfigFromEnv(process.env)
  const logger = createLogger(config.logLevel)
  const database = createDb(config.databaseUrl)

  const latestCursor = async (): Promise<IndexerCursor | null> => {
    const rows = await database.db
      .select({ slot: schema.indexerCursor.slot, updatedAt: schema.indexerCursor.updatedAt })
      .from(schema.indexerCursor)
      .orderBy(desc(schema.indexerCursor.updatedAt))
      .limit(1)
    return rows[0] ?? null
  }

  const reader = drizzleIndexReader(database.db)
  const feed = createFeed({
    // The poller runs as the company: every panel of that company shares it.
    source: (companyId, since) => reader.feed({ companyId }, companyId, since),
    onError: (err, companyId) => logger.error({ err, companyId }, 'feed poll failed'),
  })

  const app = createApp({
    logger,
    webOrigins: config.webOrigins,
    health: { ping: database.ping, cursor: latestCursor },
    auth: {
      nonces: drizzleNonceStore(database.db),
      tokens: createSessionTokens({ secret: config.jwtSecret }),
      memberships: reader.membershipsOf,
    },
    reader,
    feed,
  })

  const server = serve({ fetch: app.fetch, port: config.port, hostname: '0.0.0.0' }, (info) => {
    logger.info({ port: info.port }, 'api listening')
  })

  // Railway sends SIGTERM on redeploy; without this the pool stays open until the
  // pooler times it out, and the free tier has few connections to spare. The
  // fallback timer covers a request that never finishes.
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      logger.info({ signal }, 'shutting down')
      const forceExit = setTimeout(() => process.exit(1), 10_000)
      server.close(() => {
        void database.close().finally(() => {
          clearTimeout(forceExit)
          process.exit(0)
        })
      })
    })
  }
}

main()
