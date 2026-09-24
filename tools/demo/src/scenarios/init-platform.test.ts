import { PublicKey } from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import { parseInitPlatformArgs } from './init-platform.ts'

// The command is typed by hand, once, against a live network, with a key that lives
// offline. Every way of getting it wrong is cheaper to catch here than after the
// transaction: `init_platform` cannot be re-run.
const WALLET = 'SysvarC1ock11111111111111111111111111111111'

describe('init-platform arguments', () => {
  it('defaults to the demo stablecoin, 1 % and no top-up', () => {
    const options = parseInitPlatformArgs(['--authority', 'key.json'])
    expect(options).toEqual({
      authority: 'key.json',
      feeBps: 100,
      paymentMint: undefined,
      feeTreasuryOwner: undefined,
      mintTo: undefined,
      mintAmount: 1_000_000n,
    })
  })

  it('needs the offline key named', () => {
    expect(() => parseInitPlatformArgs([])).toThrow(/--authority/)
  })

  it('refuses a fee the program would refuse', () => {
    expect(parseInitPlatformArgs(['--authority', 'k', '--fee-bps', '1000']).feeBps).toBe(1000)
    expect(parseInitPlatformArgs(['--authority', 'k', '--fee-bps', '0']).feeBps).toBe(0)
    for (const bad of ['1001', '-1', '1.5', 'free']) {
      expect(() => parseInitPlatformArgs(['--authority', 'k', '--fee-bps', bad])).toThrow(
        /--fee-bps/,
      )
    }
  })

  it('reads addresses as addresses', () => {
    const options = parseInitPlatformArgs([
      '--authority',
      'k',
      '--payment-mint',
      WALLET,
      '--fee-treasury-owner',
      WALLET,
    ])
    expect(options.paymentMint?.equals(new PublicKey(WALLET))).toBe(true)
    expect(options.feeTreasuryOwner?.equals(new PublicKey(WALLET))).toBe(true)
    expect(() => parseInitPlatformArgs(['--authority', 'k', '--payment-mint', 'nope'])).toThrow(
      /--payment-mint/,
    )
  })

  // The demo mints only the stablecoin it issued: it holds no authority over anyone
  // else's, and a run that silently skipped the top-up would look like it worked.
  it('refuses to promise a top-up of a stablecoin it does not issue', () => {
    expect(() =>
      parseInitPlatformArgs(['--authority', 'k', '--payment-mint', WALLET, '--mint-to', WALLET]),
    ).toThrow(/--mint-to/)
  })

  it('takes the top-up in whole stablecoins and refuses a meaningless amount', () => {
    expect(
      parseInitPlatformArgs(['--authority', 'k', '--mint-to', WALLET, '--mint-amount', '250'])
        .mintAmount,
    ).toBe(250n)
    expect(() => parseInitPlatformArgs(['--authority', 'k', '--mint-amount', '0'])).toThrow(
      /--mint-amount/,
    )
  })
})
