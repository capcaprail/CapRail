import type { InvestorView, TokenView, WalletAddress } from '@caprail/shared'
import { investorTypeLabel } from '@caprail/shared'
import { type ReactNode, useState } from 'react'
import {
  Action,
  Actions,
  Cell,
  DoubleRule,
  EmptyRows,
  Help,
  Note,
  Row,
  Table,
  With,
} from '../../components/Ledger.tsx'
import { short, utcDate, utcDateTime } from '../../format.ts'
import { DistributeForm } from './DistributeForm.tsx'
import { StatusForm } from './StatusForm.tsx'

// The register of one token (FR-003). Statuses are the officer's to set, with the
// officer's key; distributions are the administrator's. Both roles see the same rows.

type Editing =
  | { kind: 'new' }
  | { kind: 'status'; investor: InvestorView }
  | { kind: 'distribute'; investor: InvestorView }
  | null

export function RegistrySection({
  companyPda,
  token,
  investors,
  wallet,
  isAdmin,
  isOfficer,
  now,
  onSettled,
}: {
  companyPda: string
  token: TokenView
  investors: InvestorView[]
  wallet: WalletAddress
  isAdmin: boolean
  isOfficer: boolean
  now: Date
  onSettled: () => void
}) {
  const [editing, setEditing] = useState<Editing>(null)
  const close = () => setEditing(null)
  const rows = investors.filter((investor) => investor.mint === token.mint)

  return (
    <>
      <Help>
        Statuses are set by the compliance officer with the officer's own key. The administrator
        cannot change them.
      </Help>
      {isOfficer && editing === null && (
        <Actions>
          <Action onClick={() => setEditing({ kind: 'new' })}>Register an investor</Action>
        </Actions>
      )}
      {editing?.kind === 'new' && (
        <StatusForm
          companyPda={companyPda}
          mint={token.mint}
          officer={wallet}
          onClose={close}
          onSettled={onSettled}
        />
      )}
      <Table kind="reg" className="mt-3">
        <Row kind="hd">
          <Cell>Wallet</Cell>
          <DoubleRule />
          <Cell>Admission</Cell>
          <Cell>Valid until</Cell>
          <Cell>Jurisdiction · type</Cell>
          <Cell>Last change · by</Cell>
          <Cell />
        </Row>
        {rows.map((investor) => (
          <InvestorRow
            key={investor.wallet}
            investor={investor}
            now={now}
            actions={
              <>
                {isOfficer && (
                  <Action onClick={() => setEditing({ kind: 'status', investor })}>
                    Change status
                  </Action>
                )}
                {isAdmin && isAdmitted(investor, now) && (
                  <Action onClick={() => setEditing({ kind: 'distribute', investor })}>
                    Distribute
                  </Action>
                )}
              </>
            }
            form={
              editing !== null &&
              editing.kind !== 'new' &&
              editing.investor.wallet === investor.wallet ? (
                editing.kind === 'status' ? (
                  <StatusForm
                    companyPda={companyPda}
                    mint={token.mint}
                    officer={wallet}
                    initial={investor}
                    onClose={close}
                    onSettled={onSettled}
                  />
                ) : (
                  <DistributeForm
                    companyPda={companyPda}
                    token={token}
                    admin={wallet}
                    investor={investor.wallet}
                    onClose={close}
                    onSettled={onSettled}
                  />
                )
              ) : null
            }
          />
        ))}
        <EmptyRows before={1} after={5} count={rows.length === 0 ? 3 : 2} />
      </Table>
      <Help>
        Jurisdiction and type are reference fields for reports. The network refuses a transfer only
        on admission.
      </Help>
    </>
  )
}

export function isAdmitted(investor: InvestorView, now: Date): boolean {
  return investor.status === 'approved' && Date.parse(investor.expiresAt) > now.getTime()
}

function admissionCell(investor: InvestorView, now: Date) {
  switch (investor.status) {
    case 'approved':
      return isAdmitted(investor, now) ? (
        'approved'
      ) : (
        <With>
          expired
          <Note>was approved until {utcDate(investor.expiresAt)}</Note>
        </With>
      )
    case 'revoked':
      return (
        <With>
          revoked
          <Note>on {utcDate(investor.updatedAt)}</Note>
        </With>
      )
    case 'none':
      return <span className="muted">not admitted</span>
  }
}

function InvestorRow({
  investor,
  now,
  actions,
  form,
}: {
  investor: InvestorView
  now: Date
  actions: ReactNode
  form: ReactNode
}) {
  return (
    <>
      <Row>
        <Cell k mono>
          <span title={investor.wallet}>{short(investor.wallet)}</span>
        </Cell>
        <DoubleRule />
        <Cell label="Admission">{admissionCell(investor, now)}</Cell>
        <Cell date label="Valid until">
          {investor.status === 'approved' ? utcDate(investor.expiresAt) : '—'}
        </Cell>
        <Cell label="Jurisdiction · type">
          {investor.jurisdiction ?? '—'} · {investorTypeLabel(investor.investorType)}
        </Cell>
        <Cell date label="Last change · by">
          <With>
            {utcDateTime(investor.updatedAt)}
            <Note>
              by{' '}
              <span className="mono" title={investor.updatedBy}>
                {short(investor.updatedBy)}
              </span>
            </Note>
          </With>
        </Cell>
        <Cell label="">
          <span className="acts mt-0">{actions}</span>
        </Cell>
      </Row>
      {form !== null && <Row kind="form">{form}</Row>}
    </>
  )
}
