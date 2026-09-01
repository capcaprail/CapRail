import { type ApiErrorCode, apiError } from '@caprail/shared'
import type { Context, Env, ErrorHandler, NotFoundHandler } from 'hono'
import { HTTPException } from 'hono/http-exception'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type { AppEnv } from '../logger.ts'

const HTTP_STATUS: Record<ApiErrorCode, ContentfulStatusCode> = {
  INVALID_INPUT: 400,
  UNAUTHORIZED: 401,
  NOT_FOUND: 404,
  RATE_LIMITED: 429,
  INTERNAL: 500,
}

const CODE_BY_STATUS: Partial<Record<number, ApiErrorCode>> = {
  400: 'INVALID_INPUT',
  401: 'UNAUTHORIZED',
  404: 'NOT_FOUND',
  429: 'RATE_LIMITED',
}

// The only way to answer with an error: body from shared, status from the same
// code, so two routes cannot answer the same thing differently.
export function fail<E extends Env, P extends string>(
  c: Context<E, P>,
  code: ApiErrorCode,
  message: string,
  details?: Record<string, unknown>,
) {
  return c.json(apiError(code, message, details), HTTP_STATUS[code])
}

export const notFoundHandler: NotFoundHandler<AppEnv> = (c) =>
  fail(c, 'NOT_FOUND', 'no route matches this path')

// Nothing but INTERNAL leaves the process for an unexpected error: exception
// messages carry connection strings and SQL. The cause stays in the log, joined to
// the response by requestId.
export const errorHandler: ErrorHandler<AppEnv> = (err, c) => {
  const logger = c.get('logger')
  if (err instanceof HTTPException) {
    const code = CODE_BY_STATUS[err.status]
    if (code !== undefined) {
      logger?.warn({ err, status: err.status }, 'request rejected')
      return fail(c, code, err.message)
    }
  }
  logger?.error({ err }, 'unhandled error')
  return fail(c, 'INTERNAL', 'internal error')
}
