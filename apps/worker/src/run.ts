import { PROGRAM_ID } from '@caprail/chain'
import { createDb } from '@caprail/db'
import { Connection } from '@solana/web3.js'
import type { Logger } from 'pino'
import { createApplier } from './apply.ts'
import { type BackfillRpc, backfill, rpcFor } from './backfill.ts'
import type { WorkerConfig } from './config.ts'
import { cursorStore } from './cursor.ts'
import { indexStore, offerBook } from './index-store.ts'
import { createPipeline } from './pipeline.ts'
import { applyRpcFor, staleRpcFor } from './rpc.ts'
import { createStaleSweep } from './stale.ts'
import { subscribeLogs } from './subscribe.ts'

// The worker as a value: its own process locally (`index.ts`), inside the API's on
// the hosting, where the free tier gives one web service and no background worker.

// The subscription is the fast path; a backfill from the cursor on a timer is the
// slow, complete one. A dropped websocket therefore costs latency, never records —
// there is no separate reconnect dance, because the timer already is one.
const BACKFILL_EVERY_MS = 30_000
// How often to look for offers whose reading expired (`STALE_TTL_MS`) or was
// invalidated by a transfer; a pass with nothing due makes no RPC call.
const STALE_SWEEP_EVERY_MS = 5_000

export type Worker = {
  // Stops the timers and the subscription, lets the transactions in hand finish,
  // closes the worker's pool. Idempotent.
  stop: () => Promise<void>
}

// An RPC URL may carry its key in the query (Helius) or the path; logs get the host.
export function rpcHost(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return 'unparseable url'
  }
}

// Resolves once the first backfill pass has run and the subscription is open — so a
// host that waits for it serves an index that has caught up with the cursor. The
// worker has a pool of its own: a long backfill must not queue the API's reads.
export async function startWorker(options: {
  config: WorkerConfig
  logger: Logger
}): Promise<Worker> {
  const { config, logger } = options
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

  const sweep = createStaleSweep({ book: offerBook(database.db), rpc: staleRpcFor(primary) })
  let sweeping = false
  async function stalePass(): Promise<void> {
    if (sweeping) return
    sweeping = true
    try {
      const result = await sweep()
      if (result.due > 0) logger.debug(result, 'stale sweep')
    } catch (err) {
      logger.warn({ err }, 'stale sweep failed')
    } finally {
      sweeping = false
    }
  }

  await backfillPass()
  const subscription = subscribeLogs(primary, PROGRAM_ID, pipeline.push)
  const timer = setInterval(() => void backfillPass(), BACKFILL_EVERY_MS)
  const staleTimer = setInterval(() => void stalePass(), STALE_SWEEP_EVERY_MS)
  logger.info(
    {
      program: PROGRAM_ID.toBase58(),
      rpc: rpcHost(config.rpcUrl),
      fallback: config.fallbackRpcUrl === undefined ? null : rpcHost(config.fallbackRpcUrl),
    },
    'worker listening',
  )

  let stopping: Promise<void> | null = null
  return {
    stop: () => {
      stopping ??= (async () => {
        clearInterval(timer)
        clearInterval(staleTimer)
        await subscription.close().catch(() => undefined)
        await pipeline.drain()
        await database.close()
      })()
      return stopping
    },
  }
}
