import { z } from 'zod'

export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const
export type LogLevel = (typeof LOG_LEVELS)[number]

export const DEFAULT_PORT = 8787
// Supabase transaction pooler. Direct 5432 gives two connections for all services on
// the free tier, and it is IPv6-only — a wrong port fails later, in the other service.
export const POOLER_PORT = 6543

// `.env.example` ships placeholders; a value that still holds one is a copy that was
// never filled in, and the safest reaction is to not start at all.
const filled = z.string().refine((value) => !value.includes('REPLACE_ME'), {
  message: 'placeholder REPLACE_ME was not replaced',
})

function postgresPort(value: string): string | null {
  try {
    const url = new URL(value)
    if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') return null
    return url.port === '' ? '5432' : url.port
  } catch {
    return null
  }
}

const originList = z
  .string()
  .transform((value) => value.split(',').map((origin) => origin.trim()))
  .pipe(z.array(z.url()).min(1))

export const apiConfigSchema = z
  .object({
    port: z.coerce.number().int().min(1).max(65_535).prefault(DEFAULT_PORT),
    databaseUrl: filled.refine((value) => postgresPort(value) !== null, {
      message: 'expected a postgres:// connection string',
    }),
    allowDirectDatabase: z
      .string()
      .optional()
      .transform((value) => value === 'true' || value === '1'),
    logLevel: z.enum(LOG_LEVELS).prefault('info'),
    webOrigins: originList,
  })
  .refine(
    (config) =>
      config.allowDirectDatabase || postgresPort(config.databaseUrl) === String(POOLER_PORT),
    {
      path: ['databaseUrl'],
      message: `expected the transaction pooler port ${POOLER_PORT}; set ALLOW_DIRECT_DATABASE=true to opt out`,
    },
  )

export type ApiConfig = z.infer<typeof apiConfigSchema>

export function apiConfigFromEnv(env: Record<string, string | undefined>): ApiConfig {
  return apiConfigSchema.parse({
    port: env.PORT,
    databaseUrl: env.DATABASE_URL,
    allowDirectDatabase: env.ALLOW_DIRECT_DATABASE,
    logLevel: env.LOG_LEVEL,
    webOrigins: env.WEB_ORIGIN,
  })
}
