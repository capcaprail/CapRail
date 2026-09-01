import type { ProgramTransaction } from '@caprail/indexer'
import type { Logs, LogsCallback, LogsFilter, PublicKey } from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import { type LogSource, subscribeLogs } from './subscribe.ts'

function fakeSource() {
  const state: {
    callback?: LogsCallback
    filter?: LogsFilter
    commitment?: string | undefined
    removed: number[]
  } = {
    removed: [],
  }
  const source: LogSource = {
    onLogs: (filter, callback, commitment) => {
      state.filter = filter
      state.callback = callback
      state.commitment = commitment
      return 7
    },
    removeOnLogsListener: (id) => {
      state.removed.push(id)
      return Promise.resolve()
    },
  }
  return { source, state }
}

const PROGRAM = { toBase58: () => 'prog' } as unknown as PublicKey

describe('subscribeLogs', () => {
  it('subscribes to the program at confirmed and maps logs to a transaction', () => {
    const { source, state } = fakeSource()
    const seen: ProgramTransaction[] = []
    subscribeLogs(source, PROGRAM, (tx) => seen.push(tx))
    expect(state.filter).toBe(PROGRAM)
    expect(state.commitment).toBe('confirmed')

    const ok: Logs = { signature: 'sig1', logs: ['Program log: hi'], err: null }
    const failed: Logs = {
      signature: 'sig2',
      logs: ['Program log: Error Code: NotAccredited'],
      err: { InstructionError: [0, { Custom: 6000 }] },
    }
    state.callback?.(ok, { slot: 5 })
    state.callback?.(failed, { slot: 6 })
    expect(seen).toEqual([
      { signature: 'sig1', slot: 5, blockTime: null, logs: ['Program log: hi'], failed: false },
      {
        signature: 'sig2',
        slot: 6,
        blockTime: null,
        logs: ['Program log: Error Code: NotAccredited'],
        failed: true,
      },
    ])
  })

  it('removes the listener on close', async () => {
    const { source, state } = fakeSource()
    const subscription = subscribeLogs(source, PROGRAM, () => {})
    await subscription.close()
    expect(state.removed).toEqual([7])
  })
})
