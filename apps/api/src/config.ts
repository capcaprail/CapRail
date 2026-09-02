import { databaseUrlSchema, filledEnv, isPooled, POOLER_PORT } from '@caprail/db'
import { z } from 'zod'

export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const
export type LogLevel = (typeof LOG_LEVELS)[number]

export const DEFAULT_PORT = 8787
// HS256 keys shorter than the hash output are the one thing RFC 7518 forbids.
export const JWT_SECRET_MIN_LENGTH = 32

const originList = z
  .string()
  .transform((value) => value.split(',').map((origin) => origin.trim()))
  .pipe(z.array(z.url()).min(1))

export const apiConfigSchema = z
  .object({
    port: z.coerce.number().int().min(1).max(65_535).prefault(DEFAULT_PORT),
    databaseUrl: databaseUrlSchema,
    jwtSecret: filledEnv.min(JWT_SECRET_MIN_LENGTH),
    allowDirectDatabase: z
      .string()
      .optional()
      .transform((value) => value === 'true' || value === '1'),
    logLevel: z.enum(LOG_LEVELS).prefault('info'),
    webOrigins: originList,
  })
  .refine((config) => config.allowDirectDatabase || isPooled(config.databaseUrl), {
    path: ['databaseUrl'],
    message: `expected the transaction pooler port ${POOLER_PORT}; set ALLOW_DIRECT_DATABASE=true to opt out`,
  })

export type ApiConfig = z.infer<typeof apiConfigSchema>

export function apiConfigFromEnv(env: Record<string, string | undefined>): ApiConfig {
  return apiConfigSchema.parse({
    port: env.PORT,
    databaseUrl: env.DATABASE_URL,
    jwtSecret: env.JWT_SECRET,
    allowDirectDatabase: env.ALLOW_DIRECT_DATABASE,
    logLevel: env.LOG_LEVEL,
    webOrigins: env.WEB_ORIGIN,
  })
}
