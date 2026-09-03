import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { ApiError, createApiClient } from './client.ts'
import { createQueryClient } from './query.ts'

const schema = z.object({ ok: z.boolean() })

function clientWith(handler: (input: string, init: RequestInit | undefined) => Response) {
  const seen: { url: string; init: RequestInit | undefined }[] = []
  const fakeFetch: typeof fetch = async (input, init) => {
    seen.push({ url: String(input), init })
    return handler(String(input), init)
  }
  return {
    seen,
    ...createApiClient({ baseUrl: 'http://api.test/', fetch: fakeFetch, token: () => 'tok' }),
  }
}

describe('createApiClient', () => {
  it('sends json with the bearer and parses the answer through the schema', async () => {
    const api = clientWith(() => Response.json({ ok: true }))
    await expect(api.request('POST', '/x', schema, { a: 1 })).resolves.toEqual({ ok: true })
    const [call] = api.seen
    expect(call?.url).toBe('http://api.test/x')
    const headers = new Headers(call?.init?.headers)
    expect(headers.get('authorization')).toBe('Bearer tok')
    expect(headers.get('content-type')).toBe('application/json')
    expect(call?.init?.body).toBe('{"a":1}')
  })

  it('omits body and content-type on GET', async () => {
    const api = clientWith(() => Response.json({ ok: true }))
    await api.request('GET', '/x', schema)
    expect(api.seen[0]?.init?.body).toBeNull()
    expect(new Headers(api.seen[0]?.init?.headers).get('content-type')).toBeNull()
  })

  it('turns a shared-shape error into ApiError and anything else into INTERNAL', async () => {
    const shaped = clientWith(() =>
      Response.json({ error: { code: 'NOT_FOUND', message: 'gone' } }, { status: 404 }),
    )
    await expect(shaped.request('GET', '/x', schema)).rejects.toMatchObject({
      code: 'NOT_FOUND',
      status: 404,
      message: 'gone',
    })
    const html = clientWith(() => new Response('<html>bad gateway</html>', { status: 502 }))
    await expect(html.request('GET', '/x', schema)).rejects.toMatchObject({
      code: 'INTERNAL',
      status: 502,
    })
  })

  it('rejects a 200 whose body does not match the schema', async () => {
    const api = clientWith(() => Response.json({ ok: 'yes' }))
    await expect(api.request('GET', '/x', schema)).rejects.toThrow()
  })
})

describe('createQueryClient', () => {
  it('retries server errors but not client errors', () => {
    const retry = createQueryClient().getDefaultOptions().queries?.retry
    if (typeof retry !== 'function') throw new Error('retry should be a function')
    expect(retry(0, new ApiError('UNAUTHORIZED', 'x', 401))).toBe(false)
    expect(retry(0, new ApiError('INTERNAL', 'x', 500))).toBe(true)
    expect(retry(0, new TypeError('network'))).toBe(true)
    expect(retry(2, new TypeError('network'))).toBe(false)
  })
})
