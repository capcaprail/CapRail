import { type ApiErrorCode, apiErrorSchema } from '@caprail/shared'
import type { z } from 'zod'
import { type EventStreamOptions, openEventStream } from './sse.ts'

export class ApiError extends Error {
  readonly code: ApiErrorCode
  readonly status: number

  constructor(code: ApiErrorCode, message: string, status: number) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.status = status
  }
}

export type ApiClient = {
  request: <S extends z.ZodType>(
    method: 'GET' | 'POST',
    path: string,
    schema: S,
    body?: unknown,
  ) => Promise<z.output<S>>
  // An SSE subscription to `path` with the same bearer; `stop` closes it.
  stream: (
    path: string,
    handlers: Pick<EventStreamOptions, 'onFrame' | 'onStatus'>,
  ) => { stop: () => void }
}

export type ApiClientOptions = {
  baseUrl: string
  token?: () => string | null
  fetch?: typeof fetch
}

// Every response passes a schema: the API is ours, but a stale bundle against a
// newer API should fail loudly at the boundary, not render `undefined` as a
// balance. Errors keep the shared shape so the UI can branch on `code`.
export function createApiClient(options: ApiClientOptions): ApiClient {
  const doFetch = options.fetch ?? fetch
  return {
    async request(method, path, schema, body) {
      const headers = new Headers({ accept: 'application/json' })
      if (body !== undefined) headers.set('content-type', 'application/json')
      const token = options.token?.()
      if (token) headers.set('authorization', `Bearer ${token}`)

      const response = await doFetch(new URL(path, options.baseUrl), {
        method,
        headers,
        body: body === undefined ? null : JSON.stringify(body),
      })
      const json: unknown = await response.json().catch(() => undefined)
      if (!response.ok) {
        const parsed = apiErrorSchema.safeParse(json)
        if (parsed.success) {
          throw new ApiError(parsed.data.error.code, parsed.data.error.message, response.status)
        }
        throw new ApiError(
          'INTERNAL',
          `unexpected ${response.status} from the api`,
          response.status,
        )
      }
      return schema.parse(json)
    },
    stream(path, handlers) {
      return openEventStream({
        url: new URL(path, options.baseUrl),
        token: () => options.token?.() ?? null,
        fetch: doFetch,
        ...handlers,
      })
    },
  }
}
