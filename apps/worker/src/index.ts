import { pino } from 'pino'
import { workerConfigFromEnv } from './config.ts'
import { startWorker } from './run.ts'

// The worker in a process of its own — local runs and the stand. On the hosting it
// runs inside the API (`RUN_WORKER=true`).

const SHUTDOWN_GRACE_MS = 10_000

async function main(): Promise<void> {
  const config = workerConfigFromEnv(process.env)
  const logger = pino({
    level: config.logLevel,
    base: { service: 'worker' },
    timestamp: pino.stdTimeFunctions.isoTime,
  })
  const worker = await startWorker({ config, logger })

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      logger.info({ signal }, 'shutting down')
      const forceExit = setTimeout(() => process.exit(1), SHUTDOWN_GRACE_MS)
      void worker.stop().finally(() => {
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
