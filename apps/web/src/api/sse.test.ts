import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSseParser, openEventStream, type SseFrame, type StreamStatus } from './sse.ts'

describe('createSseParser', () => {
  it('parses frames split across chunks, joins data lines, skips comments', () => {
    const parser = createSseParser()
    expect(parser.push('event: attempt\nda')).toEqual([])
    expect(parser.push('ta: {"a":1}\n\n: keep-alive\n\nevent: ping\ndata: \n\n')).toEqual([
      { event: 'attempt', data: '{"a":1}', id: null },
      { event: 'ping', data: '', id: null },
    ])
  })

  it('accepts CRLF, multi-line data and ids; a blank line without data is nothing', () => {
    const parser = createSseParser()
    expect(parser.push('id: 7\r\ndata: one\r\ndata: two\r\n\r\n\r\n')).toEqual([
      { event: 'message', data: 'one\ntwo', id: '7' },
    ])
  })

  it('treats a field without a colon as an empty value', () => {
    const parser = createSseParser()
    expect(parser.push('data\n\n')).toEqual([{ event: 'message', data: '', id: null }])
  })
})

function bodyOf(chunks: string[], hold?: Promise<void>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream({
    async start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      await hold
      controller.close()
    },
  })
}

// The loop reschedules itself through `setTimeout`, and on real time a busy machine
// (the parallel `pnpm gate`) fits fewer reconnects into a wait than the test counts
// on. On fake timers each backoff fires exactly when the test advances past it, and
// the awaits in between are flushed; every step asserts where the clock stands.
const tick = async (ms: number) => {
  await vi.advanceTimersByTimeAsync(ms)
}

describe('openEventStream', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('sends the bearer, delivers frames, reconnects after the body closes with a backoff', async () => {
    const frames: SseFrame[] = []
    const statuses: StreamStatus[] = []
    const headers: string[] = []
    const waits: number[] = []
    let calls = 0
    let release: () => void = () => undefined
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const fakeFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      headers.push(new Headers(init?.headers).get('authorization') ?? '')
      calls += 1
      if (calls === 1) return new Response(bodyOf(['event: ready\ndata: {}\n\n']))
      return new Response(bodyOf(['event: attempt\ndata: {"n":2}\n\n'], held))
    }) as typeof fetch

    const stream = openEventStream({
      url: 'http://api/companies/1/events',
      token: () => 'tok',
      onFrame: (frame) => frames.push(frame),
      onStatus: (status) => statuses.push(status),
      fetch: fakeFetch,
      retryMs: [5, 50],
      setTimeout: (fn, ms) => {
        waits.push(ms)
        return globalThis.setTimeout(fn, ms)
      },
    })
    await tick(4)
    // The first body closed; the reconnect waits for its backoff, not sooner.
    expect(calls).toBe(1)
    expect(frames.map((frame) => frame.event)).toEqual(['ready'])
    await tick(1)
    expect(headers).toEqual(['Bearer tok', 'Bearer tok'])
    expect(frames.map((frame) => frame.event)).toEqual(['ready', 'attempt'])
    // The first body delivered a frame, so the retry after it starts from the first delay.
    expect(waits).toEqual([5])
    expect(statuses.map((status) => status.kind)).toEqual([
      'connecting',
      'open',
      'retrying',
      'connecting',
      'open',
    ])
    stream.stop()
    release()
    await tick(100)
    expect(calls).toBe(2)
    expect(waits).toEqual([5])
  })

  it('backs off on a non-2xx and stops when there is no token', async () => {
    const waits: number[] = []
    let calls = 0
    const stream = openEventStream({
      url: 'http://api/x',
      token: () => (calls < 3 ? 'tok' : null),
      onFrame: () => undefined,
      fetch: (async () => {
        calls += 1
        return new Response('nope', { status: 401 })
      }) as typeof fetch,
      retryMs: [1, 2, 3],
      setTimeout: (fn, ms) => {
        waits.push(ms)
        return globalThis.setTimeout(fn, ms)
      },
    })
    // One attempt per backoff step, each only once its delay has passed.
    await tick(0)
    expect([calls, waits]).toEqual([1, [1]])
    await tick(1)
    expect([calls, waits]).toEqual([2, [1, 2]])
    await tick(2)
    expect([calls, waits]).toEqual([3, [1, 2, 3]])
    // The token is gone: the next turn ends the loop instead of fetching.
    await tick(100)
    expect(calls).toBe(3)
    expect(waits).toEqual([1, 2, 3])
    stream.stop()
  })
})
