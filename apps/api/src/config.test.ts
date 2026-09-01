import { describe, expect, it } from 'vitest'
import { apiConfigFromEnv, DEFAULT_PORT } from './config.ts'

const POOLED = 'postgres://postgres.abc:pw@aws-0-eu-central-1.pooler.supabase.com:6543/postgres'
const DIRECT = 'postgres://postgres:pw@db.abc.supabase.co:5432/postgres'

const base = { DATABASE_URL: POOLED, WEB_ORIGIN: 'http://localhost:5173' }

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
  })

  it('refuses a direct connection unless opted in explicitly', () => {
    expect(() => apiConfigFromEnv({ ...base, DATABASE_URL: DIRECT })).toThrow(/6543/)
    expect(
      apiConfigFromEnv({ ...base, DATABASE_URL: DIRECT, ALLOW_DIRECT_DATABASE: 'true' })
        .allowDirectDatabase,
    ).toBe(true)
  })

  it('refuses a missing database url, a non-postgres url and a bad origin', () => {
    expect(() => apiConfigFromEnv({ WEB_ORIGIN: base.WEB_ORIGIN })).toThrow()
    expect(() => apiConfigFromEnv({ ...base, DATABASE_URL: 'mysql://x:y@h:6543/d' })).toThrow()
    expect(() => apiConfigFromEnv({ ...base, WEB_ORIGIN: 'localhost' })).toThrow()
  })
})
