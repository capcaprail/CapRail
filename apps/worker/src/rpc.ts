import { TOKEN_2022_PROGRAM_ID } from '@caprail/chain'
import { unpackAccount } from '@solana/spl-token'
import { type Connection, PublicKey } from '@solana/web3.js'
import type { ApplyRpc } from './apply.ts'
import { type BackfillRpc, rpcFor } from './backfill.ts'
import type { StaleRpc, TokenAccountState } from './stale.ts'

// Token-2022 account layout starts like the classic one: mint (32), owner (32),
// amount (8), …; extensions follow the base 165 bytes. Only the owner is read here.
const TOKEN_ACCOUNT_BASE_LENGTH = 165
const OWNER_OFFSET = 32

export function applyRpcFor(connection: Connection, programId: PublicKey): ApplyRpc {
  const backfill: BackfillRpc = rpcFor(connection, programId)
  return {
    transaction: backfill.transaction,

    tokenAccountOwner: async (account) => {
      const info = await connection.getAccountInfo(new PublicKey(account), 'confirmed')
      if (
        info === null ||
        !info.owner.equals(TOKEN_2022_PROGRAM_ID) ||
        info.data.length < TOKEN_ACCOUNT_BASE_LENGTH
      ) {
        return null
      }
      return new PublicKey(info.data.subarray(OWNER_OFFSET, OWNER_OFFSET + 32)).toBase58()
    },

    tokenAccountBalance: async (account) => {
      try {
        const { context, value } = await connection.getTokenAccountBalance(
          new PublicKey(account),
          'confirmed',
        )
        return { amount: BigInt(value.amount), slot: context.slot }
      } catch (err) {
        // The RPC answers a missing account with an error, not a null value.
        if (err instanceof Error && /could not find account/i.test(err.message)) return null
        throw err
      }
    },
  }
}

export function staleRpcFor(connection: Connection): StaleRpc {
  return {
    tokenAccounts: async (accounts) => {
      const keys = accounts.map((account) => new PublicKey(account))
      const { context, value } = await connection.getMultipleAccountsInfoAndContext(
        keys,
        'confirmed',
      )
      return {
        slot: context.slot,
        accounts: value.map((info, i): TokenAccountState | null => {
          const key = keys[i]
          // Closed, or something that is not a Token-2022 account at that address.
          if (info === null || key === undefined || !info.owner.equals(TOKEN_2022_PROGRAM_ID)) {
            return null
          }
          const account = unpackAccount(key, info, TOKEN_2022_PROGRAM_ID)
          return {
            amount: account.amount,
            delegate: account.delegate?.toBase58() ?? null,
            delegatedAmount: account.delegatedAmount,
            frozen: account.isFrozen,
          }
        }),
      }
    },
  }
}
