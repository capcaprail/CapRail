import { describe, expect, it } from 'vitest'
import { rpcHost } from './run.ts'

describe('rpcHost', () => {
  it('keeps a key in the query or the path out of the logs', () => {
    expect(rpcHost('https://devnet.helius-rpc.com/?api-key=secret-key')).toBe(
      'devnet.helius-rpc.com',
    )
    expect(rpcHost('https://solana-devnet.g.alchemy.com/v2/secret-key')).toBe(
      'solana-devnet.g.alchemy.com',
    )
    expect(rpcHost('http://127.0.0.1:8899')).toBe('127.0.0.1:8899')
  })

  it('says nothing of a value it cannot parse', () => {
    expect(rpcHost('not a url secret-key')).toBe('unparseable url')
  })
})
