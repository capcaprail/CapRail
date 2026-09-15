import { type CaprailProgram, createCaprailProgram, type TxPlan } from '@caprail/chain'
import { useConnection, useWallet } from '@solana/wallet-adapter-react'
import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useMemo, useState } from 'react'
import { submitPlan, type TxOutcome, type TxPhase } from './send.ts'

/** The program client on the panel's connection — builds instructions, holds no key. */
export function useProgram(): CaprailProgram {
  const { connection } = useConnection()
  return useMemo(() => createCaprailProgram(connection), [connection])
}

export type TxState =
  | { kind: 'idle' }
  | { kind: 'busy'; phase: TxPhase }
  | { kind: 'done'; outcome: TxOutcome }

export type TransactionRunner = {
  state: TxState
  run: (plan: TxPlan) => Promise<TxOutcome>
  reset: () => void
}

// One in-flight transaction per form. `run` resolves with the outcome as well as
// storing it, so a caller can chain a next step (the setup wizard) on a settled one.
export function useTransaction(): TransactionRunner {
  const { connection } = useConnection()
  const { sendTransaction } = useWallet()
  const [state, setState] = useState<TxState>({ kind: 'idle' })

  const run = useCallback(
    async (plan: TxPlan) => {
      const outcome = await submitPlan(
        {
          connection,
          send: (transaction, target) => sendTransaction(transaction, target),
          onPhase: (phase) => setState({ kind: 'busy', phase }),
        },
        plan,
      )
      setState({ kind: 'done', outcome })
      return outcome
    },
    [connection, sendTransaction],
  )
  const reset = useCallback(() => setState({ kind: 'idle' }), [])

  return { state, run, reset }
}

// The index trails the chain by the worker's round trip (a second or two, up to a
// backfill pass of 30 s if the websocket dropped). Until the feed arrives (T031),
// a settled transaction refetches the panel a few times over that window.
export const REFRESH_DELAYS_MS = [0, 2_000, 5_000, 12_000, 30_000] as const

export function useRefreshAfterTransaction(companyId: string): () => void {
  const queryClient = useQueryClient()
  return useCallback(() => {
    for (const delay of REFRESH_DELAYS_MS) {
      setTimeout(
        () => void queryClient.invalidateQueries({ queryKey: ['company', companyId] }),
        delay,
      )
    }
  }, [queryClient, companyId])
}
