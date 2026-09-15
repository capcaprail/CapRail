import { buildSetInvestorStatus } from '@caprail/chain'
import {
  INVESTOR_STATUSES,
  INVESTOR_TYPES,
  type InvestorStatus,
  type InvestorView,
  type WalletAddress,
} from '@caprail/shared'
import { PublicKey } from '@solana/web3.js'
import { type FormEvent, useState } from 'react'
import { useProgram, useTransaction } from '../../chain/hooks.ts'
import { Action, Actions, Help } from '../../components/Ledger.tsx'
import { utcDate } from '../../format.ts'
import { Field, SelectField, TxStatus } from '../Field.tsx'
import { parseStatusForm, type StatusFormRaw } from './form.ts'

// A status the officer writes to the register (FR-004). A new wallet and a change
// of an existing one are the same instruction: the record is created on first use.

const STATUS_OPTIONS = INVESTOR_STATUSES.map((status) => ({ value: status, label: status }))
const TYPE_OPTIONS = INVESTOR_TYPES.map((type) => ({ value: String(type.code), label: type.label }))

function initialRaw(initial: InvestorView | undefined): StatusFormRaw {
  if (initial === undefined) {
    return { wallet: '', status: 'approved', validUntil: '', jurisdiction: '', investorType: '1' }
  }
  return {
    wallet: initial.wallet,
    status: initial.status,
    validUntil: initial.status === 'approved' ? utcDate(initial.expiresAt) : '',
    jurisdiction: initial.jurisdiction ?? '',
    investorType: String(initial.investorType),
  }
}

export function StatusForm({
  companyPda,
  mint,
  officer,
  initial,
  onClose,
  onSettled,
}: {
  companyPda: string
  mint: string
  officer: WalletAddress
  initial?: InvestorView
  onClose: () => void
  onSettled: () => void
}) {
  const program = useProgram()
  const tx = useTransaction()
  const [raw, setRaw] = useState<StatusFormRaw>(() => initialRaw(initial))
  const [errors, setErrors] = useState<Partial<Record<keyof StatusFormRaw, string>>>({})
  const busy = tx.state.kind === 'busy'
  // Editing a field withdraws its error: the next submit judges the new value.
  const set = <K extends keyof StatusFormRaw>(key: K, value: StatusFormRaw[K]) => {
    setRaw({ ...raw, [key]: value })
    setErrors({ ...errors, [key]: undefined })
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    const parsed = parseStatusForm(raw, Math.floor(Date.now() / 1000))
    if (!parsed.ok) {
      setErrors(parsed.errors)
      return
    }
    setErrors({})
    const plan = await buildSetInvestorStatus(program, {
      company: new PublicKey(companyPda),
      mint: new PublicKey(mint),
      complianceOfficer: new PublicKey(officer),
      wallet: new PublicKey(parsed.value.wallet),
      status: parsed.value.status,
      expiresAt: parsed.value.expiresAt,
      jurisdiction: parsed.value.jurisdiction,
      investorType: parsed.value.investorType,
    })
    const outcome = await tx.run(plan)
    if (outcome.kind === 'settled') onSettled()
  }

  return (
    <form onSubmit={(event) => void submit(event)} className="mt-2">
      <Field
        id="status-wallet"
        label="Wallet"
        value={raw.wallet}
        onChange={(v) => set('wallet', v)}
        error={errors.wallet}
        wide
        mono
        disabled={busy || initial !== undefined}
      />
      <SelectField<InvestorStatus>
        id="status-status"
        label="Admission"
        value={raw.status}
        options={STATUS_OPTIONS}
        onChange={(v) => set('status', v)}
        help={
          raw.status === 'approved'
            ? 'transfers to this wallet pass while the status is valid'
            : 'transfers to this wallet are refused'
        }
        disabled={busy}
      />
      <Field
        id="status-until"
        label="Valid until"
        type="date"
        value={raw.validUntil}
        onChange={(v) => set('validUntil', v)}
        error={errors.validUntil}
        help={raw.status === 'approved' ? 'through the end of that day, UTC' : 'optional'}
        disabled={busy}
      />
      <Field
        id="status-jurisdiction"
        label="Jurisdiction"
        value={raw.jurisdiction}
        onChange={(v) => set('jurisdiction', v)}
        error={errors.jurisdiction}
        help="ISO 3166-1 alpha-2, or empty"
        placeholder="—"
        disabled={busy}
      />
      <SelectField
        id="status-type"
        label="Investor type"
        value={raw.investorType}
        options={TYPE_OPTIONS}
        onChange={(v) => set('investorType', v)}
        error={errors.investorType}
        disabled={busy}
      />
      <Actions>
        <Action submit inert={busy}>
          {busy ? 'Setting…' : 'Set status'}
        </Action>
        <Action inert={busy} onClick={onClose}>
          Close
        </Action>
      </Actions>
      <TxStatus state={tx.state} />
      <Help>Signed by the compliance officer's key; the status applies to the next transfer.</Help>
    </form>
  )
}
