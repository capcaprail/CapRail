import { PROGRAM_ID } from '@caprail/chain'
import { createDb } from '@caprail/db'
import { Connection } from '@solana/web3.js'
import { pino } from 'pino'
import { createApplier } from './apply.ts'
import { type BackfillRpc, backfill, rpcFor } from './backfill.ts'
import { workerConfigFromEnv } from './config.ts'
import { cursorStore } from './cursor.ts'
import { indexStore } from './index-store.ts'
import { createPipeline } from './pipeline.ts'
import { applyRpcFor } from './rpc.ts'
import { subscribeLogs } from './subscribe.ts'

// The subscription is the fast path; a backfill from the cursor on a timer is the
// slow, complete one. A dropped websocket therefore costs latency, never records —
// there is no separate reconnect dance, because the timer already is one.
const BACKFILL_EVERY_MS = 30_000
const SHUTDOWN_GRACE_MS = 10_000

async function main(): Promise<void> {
  const config = workerConfigFromEnv(process.env)
  const logger = pino({
    level: config.logLevel,
    base: { service: 'worker' },
    timestamp: pino.stdTimeFunctions.isoTime,
  })
  const database = createDb(config.databaseUrl)
  const store = cursorStore(database.db, PROGRAM_ID.toBase58())

  const primary = new Connection(config.rpcUrl, {
    commitment: 'confirmed',
    wsEndpoint: config.wsUrl,
  })
  const rpcs: BackfillRpc[] = [rpcFor(primary, PROGRAM_ID)]
  if (config.fallbackRpcUrl !== undefined) {
    rpcs.push(
      rpcFor(new Connection(config.fallbackRpcUrl, { commitment: 'confirmed' }), PROGRAM_ID),
    )
  }

  const pipeline = createPipeline({
    apply: createApplier({
      store: indexStore(database.db),
      rpc: applyRpcFor(primary, PROGRAM_ID),
      log: logger,
    }),
    store,
    initial: await store.load(),
    onError: (err, tx) => logger.error({ err, signature: tx.signature }, 'apply failed'),
  })

  let passing = false
  async function backfillPass(): Promise<void> {
    if (passing) return
    passing = true
    try {
      const since = pipeline.cursor()?.signature ?? null
      for (const [index, rpc] of rpcs.entries()) {
        try {
          const latest = await backfill(rpc, since, pipeline.handle)
          logger.info({ since, latest: latest?.signature ?? null, rpc: index }, 'backfill pass')
          return
        } catch (err) {
          logger.warn({ err, rpc: index }, 'backfill failed on this rpc')
        }
      }
    } finally {
      passing = false
    }
  }

  await backfillPass()
  const subscription = subscribeLogs(primary, PROGRAM_ID, pipeline.push)
  const timer = setInterval(() => void backfillPass(), BACKFILL_EVERY_MS)
  logger.info({ program: PROGRAM_ID.toBase58(), rpc: config.rpcUrl }, 'worker listening')

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      logger.info({ signal }, 'shutting down')
      clearInterval(timer)
      const forceExit = setTimeout(() => process.exit(1), SHUTDOWN_GRACE_MS)
      void subscription
        .close()
        .catch(() => undefined)
        .then(() => pipeline.drain())
        .then(() => database.close())
        .finally(() => {
          clearTimeout(forceExit)
          process.exit(0)
        })
    })
  }
}

main().catch((err: unknown) => {
  process.stderr.write(
    `worker failed to start: ${err instanceof Error ? err.message : String(err)}\n`,
  )
  process.exit(1)
})
