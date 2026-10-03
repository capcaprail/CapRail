import { createCaprailProgram } from '@caprail/chain'
import { createDb, schema } from '@caprail/db'
import { workerConfigFromEnv } from '@caprail/worker/config'
import { startWorker, type Worker } from '@caprail/worker/run'
import { serve } from '@hono/node-server'
import { Connection } from '@solana/web3.js'
import { desc } from 'drizzle-orm'
import { createApp } from './app.ts'
import { createSessionTokens } from './auth/jwt.ts'
import { drizzleNonceStore } from './auth/nonce-store.ts'
import { apiConfigFromEnv } from './config.ts'
import { createFeed } from './index/feed.ts'
import { drizzleIndexReader } from './index/reader.ts'
import { createLogger } from './logger.ts'
import { chainPlatform } from './platform.ts'
import type { IndexerCursor } from './routes/health.ts'

async function main(): Promise<void> {
  const config = apiConfigFromEnv(process.env)
  const logger = createLogger(config.logLevel)
  // Before the server binds: the platform's health check passes only once the index
  // has caught up with the cursor, so a fresh instance never serves a stale index.
  const worker: Worker | null = config.runWorker
    ? await startWorker({
        config: workerConfigFromEnv(process.env),
        logger: logger.child({ component: 'worker' }),
      })
    : null
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
  const platform = chainPlatform(
    createCaprailProgram(new Connection(config.rpcUrl, { commitment: 'confirmed' })),
    config.paymentSymbol,
  )
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
    platform,
  })

  const server = serve({ fetch: app.fetch, port: config.port, hostname: '0.0.0.0' }, (info) => {
    logger.info({ port: info.port }, 'api listening')
  })

  // The platform sends SIGTERM on redeploy; without this the pools stay open until
  // the pooler times them out, and the free tier has few connections to spare. The
  // worker stops first — a transaction it is applying finishes, nothing new starts.
  // The fallback timer covers a request (an open SSE stream) that never finishes.
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      logger.info({ signal }, 'shutting down')
      const forceExit = setTimeout(() => process.exit(1), 10_000)
      void (worker?.stop() ?? Promise.resolve())
        .catch((err: unknown) => logger.error({ err }, 'worker did not stop cleanly'))
        .then(
          () =>
            new Promise<void>((resolve) => {
              server.close(() => resolve())
            }),
        )
        .then(() => database.close())
        .finally(() => {
          clearTimeout(forceExit)
          process.exit(0)
        })
    })
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`api failed to start: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
