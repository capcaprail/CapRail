import { databaseUrlSchema, filledEnv, isPooled, POOLER_PORT } from '@caprail/db'
import { PAYMENT_SYMBOL_MAX_LENGTH } from '@caprail/shared'
import { z } from 'zod'

export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const
export type LogLevel = (typeof LOG_LEVELS)[number]

export const DEFAULT_PORT = 8787
// HS256 keys shorter than the hash output are the one thing RFC 7518 forbids.
export const JWT_SECRET_MIN_LENGTH = 32

const httpUrl = filledEnv.pipe(z.url({ protocol: /^https?$/ }))

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
    // Read once, for `PlatformConfig` (the fee the market quotes); the index is the
    // API's source for everything else.
    rpcUrl: httpUrl,
    // The label of the payment mint in quotes (`dUSD` on the demo). Not on chain —
    // the demo stablecoin has no metadata — and unset means the panel names the mint
    // by its address rather than by a symbol it might not be.
    paymentSymbol: z
      .string()
      .trim()
      .max(PAYMENT_SYMBOL_MAX_LENGTH)
      .optional()
      .transform((value) => (value === undefined || value === '' ? null : value)),
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
    rpcUrl: env.DEVNET_RPC_URL,
    paymentSymbol: env.PAYMENT_SYMBOL,
  })
}
