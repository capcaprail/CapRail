import { toPlan } from '@caprail/chain'
import { type Connection, Keypair, PublicKey, TransactionInstruction } from '@solana/web3.js'
import { describe, expect, it } from 'vitest'
import { logsOf, reasonFromLogs, type SubmitDeps, submitPlan } from './send.ts'

const REFUSAL = [
  'Program log: Instruction: Execute',
  'Program log: AnchorError occurred. Error Code: NotAccredited. Error Number: 6000. Error Message: recipient is not an accredited investor of this company.',
]

const payer = Keypair.generate().publicKey
const plan = toPlan('distribute', payer, [
  new TransactionInstruction({ programId: PublicKey.default, keys: [], data: Buffer.alloc(0) }),
])

type Script = {
  simulate?: { err: unknown; logs: string[] | null }
  send?: () => Promise<string>
  confirm?: () => Promise<{ context: { slot: number }; value: { err: unknown } }>
  transactionLogs?: string[]
}

function depsWith(script: Script): SubmitDeps & { phases: string[] } {
  const phases: string[] = []
  const connection = {
    getLatestBlockhash: async () => ({
      blockhash: '11111111111111111111111111111111',
      lastValidBlockHeight: 100,
    }),
    simulateTransaction: async () => ({
      context: { slot: 1 },
      value: script.simulate ?? { err: null, logs: [] },
    }),
    confirmTransaction:
      script.confirm ?? (async () => ({ context: { slot: 42 }, value: { err: null } })),
    getTransaction: async () => ({ meta: { logMessages: script.transactionLogs ?? [] } }),
  } as unknown as Connection
  return {
    connection,
    send: script.send ?? (async () => 'sig'),
    onPhase: (phase) => phases.push(phase),
    phases,
  }
}

describe('reasonFromLogs', () => {
  it('reads the Anchor error code and ignores everything else', () => {
    expect(reasonFromLogs(REFUSAL)).toBe('NotAccredited')
    expect(reasonFromLogs(['Program log: hello'])).toBeNull()
  })
})

describe('logsOf', () => {
  it('finds logs on the error or on the wrapped error, and nothing elsewhere', () => {
    expect(logsOf({ logs: ['a'] })).toEqual(['a'])
    expect(logsOf({ error: { error: { logs: ['b'] } } })).toEqual(['b'])
    expect(logsOf(new Error('declined'))).toBeNull()
    expect(logsOf({ logs: [1] })).toBeNull()
  })
})

describe('submitPlan', () => {
  it('settles: simulate → sign → confirm, with the phases in that order', async () => {
    const deps = depsWith({})
    await expect(submitPlan(deps, plan)).resolves.toEqual({
      kind: 'settled',
      signature: 'sig',
      slot: 42,
    })
    expect(deps.phases).toEqual(['simulating', 'signing', 'confirming'])
  })

  it('a simulation refusal never reaches the wallet', async () => {
    let asked = false
    const deps = depsWith({
      simulate: { err: { InstructionError: [0, { Custom: 6000 }] }, logs: REFUSAL },
      send: async () => {
        asked = true
        return 'sig'
      },
    })
    await expect(submitPlan(deps, plan)).resolves.toEqual({
      kind: 'refused',
      reason: 'NotAccredited',
      logs: REFUSAL,
      signature: null,
    })
    expect(asked).toBe(false)
    expect(deps.phases).toEqual(['simulating'])
  })

  it('a preflight refusal from the wallet is a refusal, a declined signature a failure', async () => {
    const refused = depsWith({
      send: async () => {
        throw Object.assign(new Error('preflight'), { error: { logs: REFUSAL } })
      },
    })
    await expect(submitPlan(refused, plan)).resolves.toMatchObject({
      kind: 'refused',
      reason: 'NotAccredited',
    })
    const declined = depsWith({
      send: async () => {
        throw new Error('User rejected the request')
      },
    })
    await expect(submitPlan(declined, plan)).resolves.toEqual({
      kind: 'failed',
      message: 'User rejected the request',
    })
  })

  it('a transaction that lands with an error is refused with the ledger logs', async () => {
    const landed = depsWith({
      confirm: async () => ({ context: { slot: 7 }, value: { err: { InstructionError: [] } } }),
      transactionLogs: REFUSAL,
    })
    await expect(submitPlan(landed, plan)).resolves.toEqual({
      kind: 'refused',
      reason: 'NotAccredited',
      logs: REFUSAL,
      signature: 'sig',
    })
    // The web3.js race: the confirmation rejects with the bare error object.
    const raced = depsWith({
      confirm: async () => {
        throw { InstructionError: [0, 'Custom'] }
      },
      transactionLogs: REFUSAL,
    })
    await expect(submitPlan(raced, plan)).resolves.toMatchObject({
      kind: 'refused',
      signature: 'sig',
    })
    const expired = depsWith({
      confirm: async () => {
        throw new Error('block height exceeded')
      },
    })
    await expect(submitPlan(expired, plan)).resolves.toEqual({
      kind: 'failed',
      message: 'block height exceeded',
    })
  })
})
