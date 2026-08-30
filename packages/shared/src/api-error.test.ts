import { describe, expect, it } from 'vitest'
import { API_ERROR_CODES, apiError, apiErrorSchema } from './api-error.ts'

describe('apiError', () => {
  it('builds the wire shape with optional details', () => {
    expect(apiError('NOT_FOUND', 'company not found')).toEqual({
      error: { code: 'NOT_FOUND', message: 'company not found' },
    })
    expect(apiError('INVALID_INPUT', 'bad wallet', { field: 'wallet' })).toEqual({
      error: { code: 'INVALID_INPUT', message: 'bad wallet', details: { field: 'wallet' } },
    })
  })

  it('round-trips through the schema for every code', () => {
    for (const code of API_ERROR_CODES) {
      const body = apiError(code, 'x')
      expect(apiErrorSchema.parse(JSON.parse(JSON.stringify(body)))).toEqual(body)
    }
  })

  it('rejects unknown codes and missing message', () => {
    expect(apiErrorSchema.safeParse({ error: { code: 'TEAPOT', message: 'x' } }).success).toBe(
      false,
    )
    expect(apiErrorSchema.safeParse({ error: { code: 'INTERNAL' } }).success).toBe(false)
    expect(apiErrorSchema.safeParse({ message: 'x' }).success).toBe(false)
  })
})
