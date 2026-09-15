import { buildSetPolicy } from '@caprail/chain'
import type { TokenView, WalletAddress } from '@caprail/shared'
import { PublicKey } from '@solana/web3.js'
import { type FormEvent, useState } from 'react'
import { useProgram, useTransaction } from '../../chain/hooks.ts'
import { Action, Actions, Help, KV, Note, With } from '../../components/Ledger.tsx'
import { utcDateTime } from '../../format.ts'
import { CheckField, TxStatus } from '../Field.tsx'
import { policyChanged, policyInput } from './form.ts'

// The policy as the index shows it, and the one live switch the administrator has
// until M4. A change is a new version of the same rule — the token is not reissued.

export function PolicySection({
  companyPda,
  token,
  admin,
  isAdmin,
  onSettled,
}: {
  companyPda: string
  token: TokenView
  admin: WalletAddress
  isAdmin: boolean
  onSettled: () => void
}) {
  const [editing, setEditing] = useState(false)
  return (
    <>
      <KV
        rows={[
          ['Admission required', token.policy.requireAccreditation ? 'yes' : 'no'],
          [
            'Right of first refusal',
            <With key="rofr">
              not available in this version
              <Note>Until then every transfer to an admitted wallet goes through.</Note>
            </With>,
            { muted: true },
          ],
          [
            'Version',
            <With key="v">
              {token.policyVersion}
              {token.createdAt !== null && <Note>token issued {utcDateTime(token.createdAt)}</Note>}
            </With>,
          ],
        ]}
      />
      {isAdmin && !editing && (
        <Actions>
          <Action onClick={() => setEditing(true)}>Change policy</Action>
        </Actions>
      )}
      {editing && (
        <PolicyForm
          companyPda={companyPda}
          token={token}
          admin={admin}
          onClose={() => setEditing(false)}
          onSettled={onSettled}
        />
      )}
      <Help>A change applies to the next transfer. The token is not reissued.</Help>
    </>
  )
}

function PolicyForm({
  companyPda,
  token,
  admin,
  onClose,
  onSettled,
}: {
  companyPda: string
  token: TokenView
  admin: WalletAddress
  onClose: () => void
  onSettled: () => void
}) {
  const program = useProgram()
  const tx = useTransaction()
  const [requireAccreditation, setRequire] = useState(token.policy.requireAccreditation)
  const busy = tx.state.kind === 'busy'
  const next = policyInput({ requireAccreditation })
  const changed = policyChanged(token.policy, next)

  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!changed) return
    const plan = await buildSetPolicy(program, {
      company: new PublicKey(companyPda),
      mint: new PublicKey(token.mint),
      admin: new PublicKey(admin),
      policy: next,
    })
    const outcome = await tx.run(plan)
    if (outcome.kind === 'settled') onSettled()
  }

  return (
    <form onSubmit={(event) => void submit(event)} className="mt-3">
      <CheckField
        id="policy-admission"
        label="Admission required"
        checked={requireAccreditation}
        onChange={setRequire}
        help={
          requireAccreditation
            ? 'a transfer to a wallet without a valid status is refused by the network'
            : 'any wallet may receive the token; the register becomes reference only'
        }
        disabled={busy}
      />
      <CheckField
        id="policy-rofr"
        label="Right of first refusal"
        checked={false}
        onChange={() => undefined}
        help="not available in this version; the program refuses it"
        disabled
      />
      <Actions>
        <Action submit inert={busy || !changed}>
          {busy ? 'Setting…' : `Set policy · version ${token.policyVersion + 1}`}
        </Action>
        <Action inert={busy} onClick={onClose}>
          Close
        </Action>
      </Actions>
      <TxStatus state={tx.state} />
    </form>
  )
}
