import type { CompanyView, InvestorView, TokenView } from '@caprail/shared'
import { Link, useParams } from 'react-router-dom'
import { useSession } from '../auth/SessionProvider.tsx'
import { rolesIn } from '../auth/session.ts'
import { useRefreshAfterTransaction } from '../chain/hooks.ts'
import { Cell, DoubleRule, EmptyRows, Help, Row, Table } from '../components/Ledger.tsx'
import { short, utcDateTime } from '../format.ts'
import { isCatchingUp, useCompany, useInvestors } from './api.ts'
import { fromBaseUnits } from './fields.ts'
import { PolicySection } from './policy/PolicyForm.tsx'
import { RegistrySection } from './registry/Registry.tsx'

// The company panel on the index (FR-001…FR-004). Everything here is what the
// worker read from the chain; every action is a transaction the wallet signs.

export function CompanyPanel() {
  const { companyId = '' } = useParams()
  const { session } = useSession()
  const company = useCompany(companyId)
  const investors = useInvestors(companyId)
  const refresh = useRefreshAfterTransaction(companyId)

  if (session === null) return null
  const roles = rolesIn(session, companyId)
  const isAdmin = roles.includes('admin')
  const isOfficer = roles.includes('compliance_officer')

  if (company.isPending) {
    return (
      <>
        <h1>Company</h1>
        <div className="sub muted">reading the index…</div>
      </>
    )
  }
  if (company.isError) {
    return (
      <>
        <h1>Company</h1>
        {isCatchingUp(company.error) ? (
          <div className="sub">
            The index does not list this key as a role holder of company{' '}
            <span className="mono">{companyId}</span> yet. A company created a moment ago appears
            within seconds — this page keeps asking. If the roles were changed on chain, the index
            is right and the panel is not yours any more.
          </div>
        ) : (
          <div className="sub text-stamp">{company.error.message}</div>
        )}
      </>
    )
  }

  const view = company.data
  const now = new Date()
  return (
    <>
      <h1>{view.name}</h1>
      <div className="sub">
        Company <span className="mono">{view.companyId}</span> ·{' '}
        <span className="mono" title={view.company}>
          {short(view.company)}
        </span>{' '}
        · you are {roles.map((role) => role.replace('_', ' ')).join(' and ')}
      </div>
      <div className="sub muted mt-1">
        Administrator{' '}
        <span className="mono" title={view.admin}>
          {short(view.admin)}
        </span>{' '}
        · Compliance officer{' '}
        <span className="mono" title={view.complianceOfficer}>
          {short(view.complianceOfficer)}
        </span>
        {view.rolesSetAt !== null && <> · roles set {utcDateTime(view.rolesSetAt)}</>}
      </div>

      <h2>Token</h2>
      <TokenTable view={view} isAdmin={isAdmin} />

      {view.tokens.map((token) => (
        <TokenSections
          key={token.mint}
          view={view}
          token={token}
          investors={investors.data ?? []}
          investorsError={investors.isError ? investors.error.message : null}
          isAdmin={isAdmin}
          isOfficer={isOfficer}
          now={now}
          onSettled={refresh}
        />
      ))}

      <h2>Cap table</h2>
      <Help>
        Holdings are indexed from the chain as transfers settle; the live cap table and the transfer
        journal are the next step of this milestone.
      </Help>
    </>
  )
}

function TokenTable({ view, isAdmin }: { view: CompanyView; isAdmin: boolean }) {
  return (
    <>
      <Table kind="tok">
        <Row kind="hd">
          <Cell>Name · symbol</Cell>
          <DoubleRule />
          <Cell>Mint</Cell>
          <Cell>Treasury</Cell>
          <Cell fig>Issued</Cell>
          <Cell fig>Decimals</Cell>
        </Row>
        {view.tokens.map((token) => (
          <Row key={token.mint}>
            <Cell k>
              {token.name} · {token.symbol}
            </Cell>
            <DoubleRule />
            <Cell mono label="Mint">
              <span title={token.mint}>{short(token.mint)}</span>
            </Cell>
            <Cell mono label="Treasury">
              <span title={token.treasury}>{short(token.treasury)}</span>
            </Cell>
            <Cell fig label="Issued">
              {fromBaseUnits(token.totalSupply, token.decimals)} {token.symbol}
            </Cell>
            <Cell fig label="Decimals">
              {token.decimals}
            </Cell>
          </Row>
        ))}
        <EmptyRows before={1} after={4} count={view.tokens.length === 0 ? 2 : 1} />
      </Table>
      {view.tokens.length === 0 ? (
        <Help>
          No token yet.{' '}
          {isAdmin ? (
            <Link to={`/company/${view.companyId}/token`} className="act">
              Issue the token
            </Link>
          ) : (
            'The administrator issues it.'
          )}
        </Help>
      ) : (
        <Help>Issued once, in full, to the treasury; there is no mint-more instruction.</Help>
      )}
    </>
  )
}

function TokenSections({
  view,
  token,
  investors,
  investorsError,
  isAdmin,
  isOfficer,
  now,
  onSettled,
}: {
  view: CompanyView
  token: TokenView
  investors: InvestorView[]
  investorsError: string | null
  isAdmin: boolean
  isOfficer: boolean
  now: Date
  onSettled: () => void
}) {
  const { session } = useSession()
  if (session === null) return null
  const suffix = view.tokens.length > 1 ? ` · ${token.symbol}` : ''
  return (
    <>
      <h2>Policy{suffix}</h2>
      <PolicySection
        companyPda={view.company}
        token={token}
        admin={session.wallet}
        isAdmin={isAdmin}
        onSettled={onSettled}
      />

      <h2>Register of investors{suffix}</h2>
      {investorsError !== null && <div className="line text-stamp">{investorsError}</div>}
      <RegistrySection
        companyPda={view.company}
        token={token}
        investors={investors}
        wallet={session.wallet}
        isAdmin={isAdmin}
        isOfficer={isOfficer}
        now={now}
        onSettled={onSettled}
      />
    </>
  )
}
