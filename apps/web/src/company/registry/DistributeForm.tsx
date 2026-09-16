import { buildDistribute } from '@caprail/chain'
import type { TokenView, WalletAddress } from '@caprail/shared'
import { PublicKey } from '@solana/web3.js'
import { type FormEvent, useState } from 'react'
import { useProgram, useTransaction } from '../../chain/hooks.ts'
import { Action, Actions, Help } from '../../components/Ledger.tsx'
import { short } from '../../format.ts'
import { useApi } from '../../providers.tsx'
import { reportAttempt } from '../api.ts'
import { Field, TxStatus } from '../Field.tsx'
import { fromBaseUnits } from '../fields.ts'
import { attemptReportFrom } from '../journal/model.ts'
import { parseDistributeForm } from './form.ts'

// Treasury → investor, through the hook like any transfer. The investor's token
// account is created in the same instruction if missing, at the administrator's expense.
// A refusal our simulation catches is reported to the journal as `simulation`
// (FR-008); one refused on chain the worker records from the ledger.

type Report = { kind: 'none' } | { kind: 'reported' } | { kind: 'failed'; message: string }

export function DistributeForm({
  companyPda,
  token,
  admin,
  investor,
  onClose,
  onSettled,
}: {
  companyPda: string
  token: TokenView
  admin: WalletAddress
  investor: WalletAddress
  onClose: () => void
  onSettled: () => void
}) {
  const program = useProgram()
  const api = useApi()
  const tx = useTransaction()
  const [amount, setAmount] = useState('')
  const [error, setError] = useState<string | undefined>(undefined)
  const [report, setReport] = useState<Report>({ kind: 'none' })
  const busy = tx.state.kind === 'busy'
  const parsed = parseDistributeForm({ amount }, token.decimals)

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!parsed.ok) {
      setError(parsed.errors.amount)
      return
    }
    setError(undefined)
    setReport({ kind: 'none' })
    const plan = await buildDistribute(program, {
      company: new PublicKey(companyPda),
      mint: new PublicKey(token.mint),
      admin: new PublicKey(admin),
      investor: new PublicKey(investor),
      amount: parsed.value.amount,
    })
    const outcome = await tx.run(plan)
    if (outcome.kind === 'settled') onSettled()
    // The source is the treasury, owned by the company PDA — the same party the
    // worker names on a chain row of a distribution.
    const refusal = attemptReportFrom(
      {
        mint: token.mint,
        sourceOwner: companyPda,
        destOwner: investor,
        amount: parsed.value.amount,
      },
      outcome,
    )
    if (refusal === null) return
    try {
      await reportAttempt(api, refusal)
      setReport({ kind: 'reported' })
    } catch (cause) {
      setReport({ kind: 'failed', message: cause instanceof Error ? cause.message : String(cause) })
    }
  }

  return (
    <form onSubmit={(event) => void submit(event)} className="mt-2">
      <Field
        id="distribute-amount"
        label={`Distribute to ${short(investor)}`}
        value={amount}
        onChange={(value) => {
          setAmount(value)
          setError(undefined)
        }}
        error={error}
        help={
          parsed.ok
            ? `${fromBaseUnits(parsed.value.amount, token.decimals)} ${token.symbol} from the treasury`
            : `${token.symbol}, from a treasury of ${fromBaseUnits(token.totalSupply, token.decimals)} issued`
        }
        numeric
        disabled={busy}
      />
      <Actions>
        <Action submit inert={busy}>
          {busy ? 'Sending…' : 'Distribute'}
        </Action>
        <Action inert={busy} onClick={onClose}>
          Close
        </Action>
      </Actions>
      <TxStatus state={tx.state} />
      {report.kind === 'reported' && (
        <div className="line muted">recorded in the journal as a simulation</div>
      )}
      {report.kind === 'failed' && (
        <div className="line text-stamp">not recorded in the journal: {report.message}</div>
      )}
      <Help>
        The hook checks the recipient's admission as for any transfer; the administrator pays the
        fee and, the first time, the rent of the recipient's token account.
      </Help>
    </form>
  )
}
