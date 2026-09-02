import type { Role } from '@caprail/shared'
import type { Session } from './auth/jwt.ts'
import type { Logger } from './logger.ts'

// `session` and `companyRoles` are set by the auth middleware; a route reads them
// only when it is mounted behind that middleware, which is what makes the types
// non-optional without a check that could never fail.
export type AppEnv = {
  Variables: {
    logger: Logger
    requestId: string
    session: Session
    companyRoles: Role[]
  }
}
