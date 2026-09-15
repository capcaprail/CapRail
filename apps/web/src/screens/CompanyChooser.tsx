import { Link } from 'react-router-dom'
import { useSession } from '../auth/SessionProvider.tsx'
import { companyMemberships } from '../auth/session.ts'
import { Actions, Cell, DoubleRule, EmptyRows, Help, Row, Table } from '../components/Ledger.tsx'
import { short } from '../format.ts'

// Reached when a key holds a role in more than one company, or in none: the
// list is the snapshot from sign-in, the panel itself re-checks on every request.
export function CompanyChooser() {
  const { session } = useSession()
  const memberships = companyMemberships(session?.memberships ?? [])
  const companies = [...new Set(memberships.map((m) => m.companyId))]

  return (
    <>
      <h1>Companies</h1>
      <div className="sub">Companies where this key holds a role.</div>

      <h2>Roles</h2>
      <Table kind="kv">
        <Row kind="hd">
          <Cell k>Company</Cell>
          <DoubleRule />
          <Cell fig>Role</Cell>
        </Row>
        {companies.map((companyId) => (
          <Row key={companyId}>
            <Cell k>
              <Link to={`/company/${companyId}`} className="act mono">
                {short(companyId)}
              </Link>
            </Cell>
            <DoubleRule />
            <Cell fig>
              {memberships
                .filter((m) => m.companyId === companyId)
                .map((m) => m.role.replace('_', ' '))
                .join(', ')}
            </Cell>
          </Row>
        ))}
        <EmptyRows before={1} after={1} count={companies.length === 0 ? 2 : 1} />
      </Table>
      {companies.length === 0 && (
        <Help>
          This key is neither an administrator nor a compliance officer of any company. The{' '}
          <Link to="/cabinet" className="act">
            investor cabinet
          </Link>{' '}
          is available to every signed-in wallet.
        </Help>
      )}
      <Actions>
        <Link to="/company/new" className="act">
          Create a company
        </Link>
      </Actions>
      <Help>
        Two transactions signed by this key: the company with its two roles, then the token with its
        policy. This key becomes the administrator.
      </Help>
    </>
  )
}
