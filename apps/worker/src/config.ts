import { databaseUrlSchema, filledEnv, isPooled, POOLER_PORT } from '@caprail/db'
import { z } from 'zod'

export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const
export type LogLevel = (typeof LOG_LEVELS)[number]

const httpUrl = filledEnv.pipe(z.url({ protocol: /^https?$/ }))
const wsUrl = filledEnv.pipe(z.url({ protocol: /^wss?$/ }))

export const workerConfigSchema = z
  .object({
    databaseUrl: databaseUrlSchema,
    allowDirectDatabase: z
      .string()
      .optional()
      .transform((value) => value === 'true' || value === '1'),
    rpcUrl: httpUrl,
    wsUrl,
    // Used for backfill only when the primary refuses; the subscription stays on
    // the primary, whose websocket endpoint is the one we know.
    fallbackRpcUrl: httpUrl.optional(),
    logLevel: z.enum(LOG_LEVELS).prefault('info'),
  })
  .refine((config) => config.allowDirectDatabase || isPooled(config.databaseUrl), {
    path: ['databaseUrl'],
    message: `expected the transaction pooler port ${POOLER_PORT}; set ALLOW_DIRECT_DATABASE=true to opt out`,
  })

export type WorkerConfig = z.infer<typeof workerConfigSchema>

export function workerConfigFromEnv(env: Record<string, string | undefined>): WorkerConfig {
  return workerConfigSchema.parse({
    databaseUrl: env.DATABASE_URL,
    allowDirectDatabase: env.ALLOW_DIRECT_DATABASE,
    rpcUrl: env.DEVNET_RPC_URL,
    wsUrl: env.DEVNET_WS_URL,
    // Railway leaves an unset variable as '' when it was ever declared in the panel.
    fallbackRpcUrl: env.DEVNET_RPC_FALLBACK_URL === '' ? undefined : env.DEVNET_RPC_FALLBACK_URL,
    logLevel: env.LOG_LEVEL,
  })
}
