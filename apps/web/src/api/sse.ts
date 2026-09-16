// Server-sent events over `fetch`. `EventSource` cannot send a bearer header, and a
// token in the query string would land in proxy logs and browser history; the
// stream is read off `fetch` instead, with the same `Authorization` the rest of
// the API gets, and the frames are parsed here.

export type SseFrame = { event: string; data: string; id: string | null }

// Incremental parser for the `text/event-stream` format: feed it chunks as they
// arrive, get the frames that completed. A frame ends at a blank line; `data:`
// lines join with `\n`; a `:` line is a comment; CRLF is accepted.
export function createSseParser(): { push: (chunk: string) => SseFrame[]; flush: () => void } {
  let buffer = ''
  let event = ''
  let data: string[] = []
  let id: string | null = null

  const reset = () => {
    event = ''
    data = []
    id = null
  }
  // A blank line ends the frame; a frame without data is dropped, as the spec says.
  const endFrame = (): SseFrame | null => {
    const frame =
      data.length === 0
        ? null
        : { event: event === '' ? 'message' : event, data: data.join('\n'), id }
    reset()
    return frame
  }
  const field = (name: string, value: string) => {
    if (name === 'event') event = value
    else if (name === 'data') data.push(value)
    else if (name === 'id') id = value
  }
  const line = (text: string): SseFrame | null => {
    if (text === '') return endFrame()
    if (text.startsWith(':')) return null
    const colon = text.indexOf(':')
    const value = colon < 0 ? '' : text.slice(colon + 1)
    field(colon < 0 ? text : text.slice(0, colon), value.startsWith(' ') ? value.slice(1) : value)
    return null
  }

  return {
    push(chunk) {
      buffer += chunk
      const frames: SseFrame[] = []
      let end = buffer.search(/\r\n|\n|\r/)
      while (end >= 0) {
        const text = buffer.slice(0, end)
        buffer = buffer.slice(end + (buffer.startsWith('\r\n', end) ? 2 : 1))
        const frame = line(text)
        if (frame !== null) frames.push(frame)
        end = buffer.search(/\r\n|\n|\r/)
      }
      return frames
    },
    flush() {
      buffer = ''
      reset()
    },
  }
}

export type StreamStatus =
  | { kind: 'connecting' }
  | { kind: 'open' }
  // Waiting `inMs` before the next attempt; `message` is why the last one ended.
  | { kind: 'retrying'; inMs: number; message: string }

export type EventStreamOptions = {
  url: string | URL
  token: () => string | null
  onFrame: (frame: SseFrame) => void
  onStatus?: (status: StreamStatus) => void
  fetch?: typeof fetch
  // Backoff between attempts; the last value repeats.
  retryMs?: readonly number[]
  setTimeout?: (fn: () => void, ms: number) => unknown
}

export const RETRY_MS = [1_000, 2_000, 5_000, 10_000] as const

// Opens the stream and keeps it open until `stop()`: a closed body, a non-2xx or a
// thrown fetch all lead to a retry after the backoff, which resets once a
// connection has delivered a frame. A missing token ends the loop — there is no
// session to stream for.
export function openEventStream(options: EventStreamOptions): { stop: () => void } {
  const doFetch = options.fetch ?? fetch
  const schedule = options.setTimeout ?? ((fn, ms) => globalThis.setTimeout(fn, ms))
  const retryMs = options.retryMs ?? RETRY_MS
  const status = options.onStatus ?? (() => undefined)
  const controller = new AbortController()
  let attempt = 0

  // One connection, start to end; the reason it ended, or null when stopped.
  const once = async (token: string): Promise<string | null> => {
    try {
      const response = await doFetch(options.url, {
        headers: { accept: 'text/event-stream', authorization: `Bearer ${token}` },
        signal: controller.signal,
      })
      if (!response.ok || response.body === null) return `api answered ${response.status}`
      status({ kind: 'open' })
      await read(response.body)
      return 'stream closed'
    } catch (error) {
      if (controller.signal.aborted) return null
      return error instanceof Error ? error.message : String(error)
    }
  }

  const connect = async (): Promise<void> => {
    const token = options.token()
    if (token === null || controller.signal.aborted) return
    status({ kind: 'connecting' })
    const message = await once(token)
    if (message === null || controller.signal.aborted) return
    const wait = retryMs[Math.min(attempt, retryMs.length - 1)] ?? 0
    attempt += 1
    status({ kind: 'retrying', inMs: wait, message })
    schedule(() => void connect(), wait)
  }

  const read = async (body: ReadableStream<Uint8Array>): Promise<void> => {
    const reader = body.getReader()
    const decoder = new TextDecoder()
    const parser = createSseParser()
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) return
        for (const frame of parser.push(decoder.decode(value, { stream: true }))) {
          attempt = 0
          options.onFrame(frame)
        }
      }
    } finally {
      reader.cancel().catch(() => undefined)
    }
  }

  void connect()
  return { stop: () => controller.abort() }
}
