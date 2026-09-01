import { z } from 'zod'

// Supabase transaction pooler. Direct 5432 gives two connections for all services on
// the free tier, and it is IPv6-only — a wrong port fails later, in the other service.
export const POOLER_PORT = 6543

export function postgresPort(value: string): string | null {
  try {
    const url = new URL(value)
    if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') return null
    return url.port === '' ? '5432' : url.port
  } catch {
    return null
  }
}

// `.env.example` ships placeholders; a value that still holds one is a copy that was
// never filled in, and the safest reaction is to not start at all.
export const filledEnv = z.string().refine((value) => !value.includes('REPLACE_ME'), {
  message: 'placeholder REPLACE_ME was not replaced',
})

export const databaseUrlSchema = filledEnv.refine((value) => postgresPort(value) !== null, {
  message: 'expected a postgres:// connection string',
})

export function isPooled(databaseUrl: string): boolean {
  return postgresPort(databaseUrl) === String(POOLER_PORT)
}
