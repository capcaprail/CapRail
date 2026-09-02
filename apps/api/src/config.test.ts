import { describe, expect, it } from 'vitest'
import { apiConfigFromEnv, DEFAULT_PORT } from './config.ts'

const POOLED = 'postgres://postgres.abc:pw@aws-0-eu-central-1.pooler.supabase.com:6543/postgres'
const DIRECT = 'postgres://postgres:pw@db.abc.supabase.co:5432/postgres'

const SECRET = 'x'.repeat(32)

const base = { DATABASE_URL: POOLED, WEB_ORIGIN: 'http://localhost:5173', JWT_SECRET: SECRET }

describe('apiConfigFromEnv', () => {
  it('parses a filled-in environment with defaults', () => {
    const config = apiConfigFromEnv(base)
    expect(config.port).toBe(DEFAULT_PORT)
    expect(config.logLevel).toBe('info')
    expect(config.webOrigins).toEqual(['http://localhost:5173'])
    expect(config.allowDirectDatabase).toBe(false)
  })

  it('splits several origins and coerces the port', () => {
    const config = apiConfigFromEnv({
      ...base,
      PORT: '9000',
      WEB_ORIGIN: 'http://localhost:5173, https://caprail.example',
    })
    expect(config.port).toBe(9000)
    expect(config.webOrigins).toEqual(['http://localhost:5173', 'https://caprail.example'])
  })

  it('refuses a placeholder left from .env.example', () => {
    expect(() =>
      apiConfigFromEnv({ ...base, DATABASE_URL: POOLED.replace('pw', 'REPLACE_ME') }),
    ).toThrow(/REPLACE_ME/)
    expect(() => apiConfigFromEnv({ ...base, JWT_SECRET: 'REPLACE_ME' })).toThrow(/REPLACE_ME/)
  })

  it('refuses a jwt secret shorter than the hmac output', () => {
    expect(() => apiConfigFromEnv({ ...base, JWT_SECRET: 'x'.repeat(31) })).toThrow(/32/)
    expect(() => apiConfigFromEnv({ ...base, JWT_SECRET: undefined })).toThrow()
  })

  it('refuses a direct connection unless opted in explicitly', () => {
    expect(() => apiConfigFromEnv({ ...base, DATABASE_URL: DIRECT })).toThrow(/6543/)
    expect(
      apiConfigFromEnv({ ...base, DATABASE_URL: DIRECT, ALLOW_DIRECT_DATABASE: 'true' })
        .allowDirectDatabase,
    ).toBe(true)
  })

  it('refuses a missing database url, a non-postgres url and a bad origin', () => {
    expect(() => apiConfigFromEnv({ WEB_ORIGIN: base.WEB_ORIGIN, JWT_SECRET: SECRET })).toThrow()
    expect(() => apiConfigFromEnv({ ...base, DATABASE_URL: 'mysql://x:y@h:6543/d' })).toThrow()
    expect(() => apiConfigFromEnv({ ...base, WEB_ORIGIN: 'localhost' })).toThrow()
  })
})
