import { describe, expect, it } from 'vitest'
import { workerConfigFromEnv } from './config.ts'

const base = {
  DATABASE_URL: 'postgres://postgres.abc:pw@aws-0-eu-central-1.pooler.supabase.com:6543/postgres',
  DEVNET_RPC_URL: 'https://api.devnet.solana.com',
  DEVNET_WS_URL: 'wss://api.devnet.solana.com',
}

describe('workerConfigFromEnv', () => {
  it('parses the primary endpoints with no fallback', () => {
    const config = workerConfigFromEnv(base)
    expect(config.rpcUrl).toBe(base.DEVNET_RPC_URL)
    expect(config.wsUrl).toBe(base.DEVNET_WS_URL)
    expect(config.fallbackRpcUrl).toBeUndefined()
    expect(config.logLevel).toBe('info')
  })

  it('accepts a fallback rpc and treats an empty one as absent', () => {
    expect(
      workerConfigFromEnv({ ...base, DEVNET_RPC_FALLBACK_URL: 'https://rpc.example' })
        .fallbackRpcUrl,
    ).toBe('https://rpc.example')
    expect(
      workerConfigFromEnv({ ...base, DEVNET_RPC_FALLBACK_URL: '' }).fallbackRpcUrl,
    ).toBeUndefined()
  })

  it('refuses placeholders, wrong schemes and a direct database port', () => {
    expect(() => workerConfigFromEnv({ ...base, DEVNET_RPC_URL: 'https://REPLACE_ME' })).toThrow()
    expect(() => workerConfigFromEnv({ ...base, DEVNET_WS_URL: 'https://not-ws' })).toThrow()
    expect(() => workerConfigFromEnv({ ...base, DEVNET_RPC_URL: 'wss://not-http' })).toThrow()
    expect(() =>
      workerConfigFromEnv({ ...base, DATABASE_URL: 'postgres://u:p@h:5432/db' }),
    ).toThrow(/6543/)
  })
})
