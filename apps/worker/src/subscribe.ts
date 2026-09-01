import type { ProgramTransaction } from '@caprail/indexer'
import type { Connection, Logs, PublicKey } from '@solana/web3.js'

export type LogSource = Pick<Connection, 'onLogs' | 'removeOnLogsListener'>

export type Subscription = { close: () => Promise<void> }

// `onLogs` gives no blockTime; the parser gets null and the applier (T028) reads
// the block time where it needs it. Logs arriving here are always the confirmed
// commitment: `processed` can be rolled back, and a rolled-back refusal in the
// journal would be a lie.
export function subscribeLogs(
  source: LogSource,
  programId: PublicKey,
  onTransaction: (tx: ProgramTransaction) => void,
): Subscription {
  const id = source.onLogs(
    programId,
    (logs: Logs, ctx) =>
      onTransaction({
        signature: logs.signature,
        slot: ctx.slot,
        blockTime: null,
        logs: logs.logs,
        failed: logs.err !== null,
      }),
    'confirmed',
  )
  return { close: () => source.removeOnLogsListener(id) }
}
