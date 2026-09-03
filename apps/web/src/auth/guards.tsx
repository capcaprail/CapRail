import type { Role } from '@caprail/shared'
import type { ReactNode } from 'react'
import { Navigate, useLocation, useParams } from 'react-router-dom'
import { useSession } from './SessionProvider.tsx'
import { COMPANY_ROLES, rolesIn } from './session.ts'

// Route guards decide only where to send the viewer; what a role may do inside
// a screen is the program's decision, re-checked by the API on every request.
export function RequireSession({ children }: { children: ReactNode }) {
  const { session, restoring } = useSession()
  const location = useLocation()
  if (restoring) return null
  if (session === null) return <Navigate to="/" replace state={{ from: location.pathname }} />
  return <>{children}</>
}

export function RequireCompanyRole({
  children,
  allowed = COMPANY_ROLES,
}: {
  children: ReactNode
  allowed?: readonly Role[]
}) {
  const { session, restoring } = useSession()
  const { companyId } = useParams()
  const location = useLocation()
  if (restoring) return null
  if (session === null) return <Navigate to="/" replace state={{ from: location.pathname }} />
  if (companyId === undefined) return <Navigate to="/company" replace />
  const held = rolesIn(session, companyId)
  if (!held.some((role) => allowed.includes(role))) return <Navigate to="/company" replace />
  return <>{children}</>
}
