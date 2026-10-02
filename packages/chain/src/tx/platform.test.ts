import { MINT_SIZE, MintLayout, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { type AccountInfo, PublicKey } from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import { platformPda } from '../pda.ts'
import type { CaprailProgram } from '../program.ts'
import { fetchPlatform } from './platform.ts'

const PAYMENT_MINT = new PublicKey('SysvarS1otHashes111111111111111111111111111')
const FEE_TREASURY = new PublicKey('SysvarS1otHistory11111111111111111111111111')

function mintAccount(decimals: number, owner: PublicKey): AccountInfo<Buffer> {
  const data = Buffer.alloc(MINT_SIZE)
  MintLayout.encode(
    {
      mintAuthorityOption: 0,
      mintAuthority: PublicKey.default,
      supply: 0n,
      decimals,
      isInitialized: true,
      freezeAuthorityOption: 0,
      freezeAuthority: PublicKey.default,
    },
    data,
  )
  return { data, owner, lamports: 1, executable: false }
}

// Only the two reads `fetchPlatform` makes; the program is never asked to send.
function fakeProgram(config: object | null, mint: AccountInfo<Buffer> | null) {
  const asked: string[] = []
  const program = {
    account: {
      platformConfig: {
        fetchNullable: async (address: PublicKey) => {
          asked.push(`config ${address.toBase58()}`)
          return config
        },
      },
    },
    provider: {
      connection: {
        getAccountInfo: async (address: PublicKey) => {
          asked.push(`mint ${address.toBase58()}`)
          return mint
        },
      },
    },
  } as unknown as CaprailProgram
  return { program, asked }
}

const CONFIG = { feeBps: 100, paymentMint: PAYMENT_MINT, feeTreasury: FEE_TREASURY }

describe('fetchPlatform', () => {
  it('takes decimals and program from the mint itself — Token-2022 or classic', async () => {
    for (const [owner, decimals] of [
      [TOKEN_2022_PROGRAM_ID, 6],
      [TOKEN_PROGRAM_ID, 9],
    ] as const) {
      const { program, asked } = fakeProgram(CONFIG, mintAccount(decimals, owner))
      expect(await fetchPlatform(program)).toEqual({
        ...CONFIG,
        paymentTokenProgram: owner,
        paymentDecimals: decimals,
      })
      expect(asked).toEqual([
        `config ${platformPda().toBase58()}`,
        `mint ${PAYMENT_MINT.toBase58()}`,
      ])
    }
  })

  it('is null before init_platform, without reading any mint', async () => {
    const { program, asked } = fakeProgram(null, null)
    expect(await fetchPlatform(program)).toBeNull()
    expect(asked).toHaveLength(1)
  })

  it('refuses a config whose mint is gone rather than guess its decimals', async () => {
    const { program } = fakeProgram(CONFIG, null)
    await expect(fetchPlatform(program)).rejects.toThrow(/does not exist/)
  })

  it('refuses an account that is not a mint of a token program', async () => {
    const { program } = fakeProgram(CONFIG, mintAccount(6, PublicKey.unique()))
    await expect(fetchPlatform(program)).rejects.toThrow()
  })
})
