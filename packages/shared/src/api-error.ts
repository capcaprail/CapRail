import { z } from 'zod'

export const API_ERROR_CODES = [
  'INVALID_INPUT',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'NOT_FOUND',
  'RATE_LIMITED',
  'INTERNAL',
] as const

export const apiErrorCodeSchema = z.enum(API_ERROR_CODES)

export type ApiErrorCode = z.infer<typeof apiErrorCodeSchema>

export const apiErrorSchema = z.object({
  error: z.object({
    code: apiErrorCodeSchema,
    message: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
})

export type ApiErrorBody = z.infer<typeof apiErrorSchema>

export function apiError(
  code: ApiErrorCode,
  message: string,
  details?: Record<string, unknown>,
): ApiErrorBody {
  return { error: details === undefined ? { code, message } : { code, message, details } }
}
