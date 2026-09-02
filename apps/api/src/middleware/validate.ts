import { zValidator } from '@hono/zod-validator'
import type { ValidationTargets } from 'hono'
import type { z } from 'zod'
import { fail } from './errors.ts'

// zValidator answers a failed parse with its own body; routing it through `fail`
// keeps every 400 in the shared error shape. Issues are reported by path only — the
// received value could be a signature or a wallet, and it is already in the request.
export function validate<T extends keyof ValidationTargets, S extends z.ZodType>(
  target: T,
  schema: S,
) {
  return zValidator(target, schema, (result, c) => {
    if (!result.success) {
      return fail(c, 'INVALID_INPUT', `invalid ${target}`, {
        issues: result.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      })
    }
    return undefined
  })
}
