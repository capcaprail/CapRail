import { buildDistribute } from '@caprail/chain'
import type { TokenView, WalletAddress } from '@caprail/shared'
import { PublicKey } from '@solana/web3.js'
import { type FormEvent, useState } from 'react'
import { useProgram, useTransaction } from '../../chain/hooks.ts'
import { Action, Actions, Help } from '../../components/Ledger.tsx'
import { short } from '../../format.ts'
import { Field, TxStatus } from '../Field.tsx'
import { fromBaseUnits } from '../fields.ts'
import { parseDistributeForm } from './form.ts'

// Treasury → investor, through the hook like any transfer. The investor's token
// account is created in the same instruction if missing, at the administrator's expense.

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
  const tx = useTransaction()
  const [amount, setAmount] = useState('')
  const [error, setError] = useState<string | undefined>(undefined)
  const busy = tx.state.kind === 'busy'
  const parsed = parseDistributeForm({ amount }, token.decimals)

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!parsed.ok) {
      setError(parsed.errors.amount)
      return
    }
    setError(undefined)
    const plan = await buildDistribute(program, {
      company: new PublicKey(companyPda),
      mint: new PublicKey(token.mint),
      admin: new PublicKey(admin),
      investor: new PublicKey(investor),
      amount: parsed.value.amount,
    })
    const outcome = await tx.run(plan)
    if (outcome.kind === 'settled') onSettled()
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
      <Help>
        The hook checks the recipient's admission as for any transfer; the administrator pays the
        fee and, the first time, the rent of the recipient's token account.
      </Help>
    </form>
  )
}
