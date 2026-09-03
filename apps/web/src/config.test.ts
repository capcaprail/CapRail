import { describe, expect, it } from 'vitest'
import { readWebConfig } from './config.ts'

describe('readWebConfig', () => {
  it('reads the two public urls', () => {
    expect(
      readWebConfig({
        VITE_API_URL: 'http://localhost:8787',
        VITE_DEVNET_RPC_URL: 'https://api.devnet.solana.com',
      }),
    ).toEqual({ apiUrl: 'http://localhost:8787', rpcUrl: 'https://api.devnet.solana.com' })
  })

  it('refuses a missing or non-url value', () => {
    expect(() => readWebConfig({ VITE_API_URL: 'http://localhost:8787' })).toThrow()
    expect(() =>
      readWebConfig({ VITE_API_URL: 'localhost', VITE_DEVNET_RPC_URL: 'https://x' }),
    ).toThrow()
  })
})
