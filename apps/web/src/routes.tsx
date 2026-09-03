import { useWalletModal } from '@solana/wallet-adapter-react-ui'
import { Navigate, NavLink, Outlet, Route, Routes } from 'react-router-dom'
import { RequireCompanyRole, RequireSession } from './auth/guards.tsx'
import { useSession } from './auth/SessionProvider.tsx'
import { companyMemberships, landingFor } from './auth/session.ts'
import { short } from './format.ts'
import { Cabinet } from './screens/Cabinet.tsx'
import { CompanyChooser } from './screens/CompanyChooser.tsx'
import { Landing } from './screens/Landing.tsx'
import { Market } from './screens/Market.tsx'
import { Register } from './screens/Register.tsx'

// Routes by role (FR-017). The screens under them are still the M0 mock-ups until
// US1 puts live data behind them; the guards are already the real ones.
export function AppRoutes() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Landing />} />
        <Route
          path="company"
          element={
            <RequireSession>
              <CompanyChooser />
            </RequireSession>
          }
        />
        <Route
          path="company/:companyId/*"
          element={
            <RequireCompanyRole>
              <Register />
            </RequireCompanyRole>
          }
        />
        <Route
          path="cabinet"
          element={
            <RequireSession>
              <Cabinet />
            </RequireSession>
          }
        />
        <Route
          path="market"
          element={
            <RequireSession>
              <Market />
            </RequireSession>
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  )
}

function Layout() {
  const { state, session, signOut } = useSession()
  const { setVisible } = useWalletModal()
  const item = ({ isActive }: { isActive: boolean }) => (isActive ? 'cur' : 'oth')
  const companies = session === null ? [] : companyMemberships(session.memberships)

  return (
    <div className="page">
      <div className="proto">Prototype — mock data. Not connected to any network.</div>
      <nav className="nav">
        {session === null ? (
          <NavLink to="/" end className={item}>
            Sign in
          </NavLink>
        ) : (
          <>
            {companies.length > 0 && (
              <NavLink to={landingFor(session.memberships)} className={item}>
                Company
              </NavLink>
            )}
            <NavLink to="/cabinet" className={item}>
              Cabinet
            </NavLink>
            <NavLink to="/market" className={item}>
              Market
            </NavLink>
          </>
        )}
        <span className="nav-wallet">
          {state.kind === 'restoring' ? (
            <span className="oth">connecting…</span>
          ) : state.kind === 'no-wallet' ? (
            <button type="button" className="act oth" onClick={() => setVisible(true)}>
              Connect wallet
            </button>
          ) : (
            <>
              <span className="mono">
                {short(state.kind === 'signed-in' ? state.session.wallet : state.wallet)}
              </span>
              {session === null && <span className="oth"> · not signed in</span>}
              <button type="button" className="act oth" onClick={signOut}>
                {session === null ? 'Disconnect' : 'Sign out'}
              </button>
            </>
          )}
        </span>
      </nav>
      <Outlet />
    </div>
  )
}
