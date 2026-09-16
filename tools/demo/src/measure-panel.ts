// The panel's half of the M1 table: SC-003 and SC-004 (T032).
//
// Not the browser but its contract. The panel learns about a transfer from the SSE
// stream `/companies/:id/events`: an `attempt` event carrying the signature, and on
// an allowed one it refetches the cap table. So "the cap table updated" and "the
// refusal is in the journal" both mean: the event for that signature reached a
// client of the API. What is measured is the delay between the transaction's
// confirmation and that moment — the whole path chain → worker → Supabase → API →
// stream, which is what the criteria are about.
//
// Two clocks per event. `sinceConfirmedMs` is the wall clock from the demo's own
// confirmation of the transaction; it is the honest number, but the demo learns of
// confirmation by polling and so counts a little of its own latency. `sinceBlockMs`
// is from the block's `blockTime` — the chain's clock, whole seconds, and the
// node's clock rather than this machine's; it is reported for the record.
import { createPrivateKey, sign as signBytes } from 'node:crypto'
import {
  authNonceResponseSchema,
  authVerifyResponseSchema,
  type CapTable,
  capTableSchema,
  companyViewSchema,
  encodeBase58,
  type FeedEvent,
  feedEventSchema,
  type JournalEntry,
  signInMessage,
  type WalletAddress,
} from '@caprail/shared'
import type { Keypair } from '@solana/web3.js'
import type { Landed, Refused } from './send.ts'

export type PanelClient = {
  readonly baseUrl: string
  readonly token: string
}

/** Wall-clock milliseconds; a parameter so the tests can script it. */
export type Now = () => number

// PKCS#8 header for an Ed25519 private key (RFC 8410): node:crypto takes no raw
// seeds, and 16 constant bytes are cheaper than a signing library next to web3.js.
const ED25519_PKCS8_PREFIX = Uint8Array.from([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
])

export function signMessage(keypair: Keypair, message: string): Uint8Array {
  const seed = keypair.secretKey.slice(0, 32)
  const der = new Uint8Array(ED25519_PKCS8_PREFIX.length + seed.length)
  der.set(ED25519_PKCS8_PREFIX)
  der.set(seed, ED25519_PKCS8_PREFIX.length)
  const key = createPrivateKey({ key: Buffer.from(der), format: 'der', type: 'pkcs8' })
  return new Uint8Array(signBytes(null, new TextEncoder().encode(message), key))
}

async function postJson(url: string, body: unknown, token?: string): Promise<unknown> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error(`${url}: ${response.status} ${await response.text()}`)
  return await response.json()
}

async function getJson(client: PanelClient, path: string): Promise<Response> {
  return await fetch(`${client.baseUrl}${path}`, {
    headers: { authorization: `Bearer ${client.token}` },
  })
}

/** The wallet sign-in the panel does: nonce → signed message → session token. */
export async function signIn(
  baseUrl: string,
  keypair: Keypair,
): Promise<{ token: string; companyIds: readonly string[] }> {
  const wallet = keypair.publicKey.toBase58() as WalletAddress
  const nonce = authNonceResponseSchema.parse(await postJson(`${baseUrl}/auth/nonce`, { wallet }))
  const signature = encodeBase58(signMessage(keypair, signInMessage(wallet, nonce.nonce)))
  const verified = authVerifyResponseSchema.parse(
    await postJson(`${baseUrl}/auth/verify`, { wallet, signature, nonce: nonce.nonce }),
  )
  return { token: verified.token, companyIds: verified.memberships.map((m) => m.companyId) }
}

/**
 * Signs in until the index knows the company. Memberships are a snapshot taken at
 * sign-in, so a session opened before the worker saw `create_company` has no
 * company in it — the panel waits the same way (T030: `FORBIDDEN` → refetch).
 */
export async function waitIndexed(
  baseUrl: string,
  keypair: Keypair,
  companyId: string,
  timeoutMs: number,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<PanelClient> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const session = await signIn(baseUrl, keypair)
    if (session.companyIds.includes(companyId)) {
      const client = { baseUrl, token: session.token }
      const response = await getJson(client, `/companies/${companyId}`)
      if (response.ok) {
        companyViewSchema.parse(await response.json())
        return client
      }
    }
    if (Date.now() > deadline) {
      throw new Error(`the index did not pick up company ${companyId} within ${timeoutMs} ms`)
    }
    await sleep(1000)
  }
}

export async function capTable(
  client: PanelClient,
  companyId: string,
  mint: string,
): Promise<CapTable> {
  const response = await getJson(client, `/companies/${companyId}/cap-table?mint=${mint}`)
  if (!response.ok) throw new Error(`cap-table: ${response.status} ${await response.text()}`)
  return capTableSchema.parse(await response.json())
}

export type SseFrame = { readonly event: string; readonly data: string }

/**
 * `text/event-stream`, the subset the API writes: `event:` and `data:` lines, a
 * blank line ends a frame, `:` lines are comments. Chunks split anywhere; the
 * remainder is kept for the next push.
 */
export function createFrameParser(): { push: (chunk: string) => SseFrame[] } {
  let buffer = ''
  return {
    push(chunk) {
      buffer += chunk
      const frames: SseFrame[] = []
      for (let end = buffer.indexOf('\n\n'); end >= 0; end = buffer.indexOf('\n\n')) {
        frames.push(parseFrame(buffer.slice(0, end)))
        buffer = buffer.slice(end + 2)
      }
      return frames
    },
  }
}

function parseFrame(block: string): SseFrame {
  let event = 'message'
  const data: string[] = []
  for (const line of block.split('\n')) {
    if (line.startsWith(':')) continue
    const colon = line.indexOf(':')
    const name = colon < 0 ? line : line.slice(0, colon)
    const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '')
    if (name === 'event') event = value
    else if (name === 'data') data.push(value)
  }
  return { event, data: data.join('\n') }
}

/** One `attempt` event as it reached the client, with the moment it did. */
export type Arrival = {
  readonly entry: JournalEntry
  readonly arrivedAt: number
}

export type Feed = {
  /** `attempt` events by signature, in arrival order; simulations have none and are not here. */
  readonly arrivals: ReadonlyMap<string, Arrival>
  /** Resolves when every signature has arrived, or the deadline passes — the count says which. */
  waitFor: (signatures: readonly string[], timeoutMs: number) => Promise<number>
  close: () => void
}

/**
 * Opens the company's event stream and keeps every `attempt` by signature. The
 * stream is read the way the panel reads it (`fetch` with the bearer header);
 * the first frame is `ready`, and nothing before it can be attributed.
 */
export async function openFeed(
  client: PanelClient,
  companyId: string,
  now: Now = Date.now,
): Promise<Feed> {
  const controller = new AbortController()
  const response = await fetch(`${client.baseUrl}/companies/${companyId}/events`, {
    headers: { authorization: `Bearer ${client.token}`, accept: 'text/event-stream' },
    signal: controller.signal,
  })
  if (!response.ok || response.body === null) {
    throw new Error(`events: ${response.status} ${await response.text()}`)
  }
  const arrivals = new Map<string, Arrival>()
  const waiters = new Set<() => void>()
  const parser = createFrameParser()
  const decoder = new TextDecoder()
  const reader = response.body.getReader()

  const record = (event: FeedEvent, arrivedAt: number): void => {
    if (event.kind !== 'attempt' || event.entry.txSignature === null) return
    arrivals.set(event.entry.txSignature, { entry: event.entry, arrivedAt })
    for (const wake of waiters) wake()
  }

  let ready: () => void = () => undefined
  const readyPromise = new Promise<void>((resolve) => {
    ready = resolve
  })
  const onFrame = (frame: SseFrame, arrivedAt: number): void => {
    if (frame.event === 'ready') ready()
    else if (frame.event === 'attempt') {
      record(feedEventSchema.parse(JSON.parse(frame.data)), arrivedAt)
    }
  }
  const pump = async (): Promise<void> => {
    for (let read = await reader.read(); !read.done; read = await reader.read()) {
      const arrivedAt = now()
      for (const frame of parser.push(decoder.decode(read.value, { stream: true }))) {
        onFrame(frame, arrivedAt)
      }
    }
  }
  // The abort on `close()` rejects the read; a dropped stream simply stops
  // recording, and the missing signatures show up in the count.
  void pump().catch(() => undefined)
  await readyPromise

  return {
    arrivals,
    waitFor: (signatures, timeoutMs) =>
      new Promise((resolve) => {
        const missing = () => signatures.filter((s) => !arrivals.has(s)).length
        const timer = setTimeout(() => {
          waiters.delete(check)
          resolve(signatures.length - missing())
        }, timeoutMs)
        const check = () => {
          if (missing() > 0) return
          clearTimeout(timer)
          waiters.delete(check)
          resolve(signatures.length)
        }
        waiters.add(check)
        check()
      }),
    close: () => controller.abort(),
  }
}

export type Latency = {
  readonly signature: string
  readonly sinceConfirmedMs: number
  readonly sinceBlockMs: number | undefined
  /** The event says what the chain said: outcome, reason and destination. */
  readonly faithful: boolean
}

export type Expectation = {
  readonly outcome: 'allowed' | 'rejected'
  readonly destOwner: string
}

export function latencyOf(
  landed: Landed | Refused,
  arrival: Arrival,
  expect: Expectation,
): Latency {
  const { entry } = arrival
  const reason = 'reason' in landed ? landed.reason : undefined
  return {
    signature: landed.signature,
    sinceConfirmedMs: arrival.arrivedAt - landed.confirmedAt,
    sinceBlockMs:
      landed.blockTime === undefined ? undefined : arrival.arrivedAt - landed.blockTime * 1000,
    faithful:
      entry.outcome === expect.outcome &&
      entry.destOwner === expect.destOwner &&
      entry.origin === 'chain' &&
      (expect.outcome === 'allowed' ? entry.reasonCode === null : entry.reasonCode === reason),
  }
}

/** Nearest-rank percentile; `p` in (0, 100]. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return Number.NaN
  const sorted = [...values].sort((a, b) => a - b)
  const rank = Math.ceil((p / 100) * sorted.length)
  return sorted[Math.max(0, Math.min(sorted.length, rank) - 1)] ?? Number.NaN
}

export type PanelMeasure = {
  readonly sent: number
  readonly arrived: number
  readonly faithful: number
  readonly p50Ms: number
  readonly p95Ms: number
  readonly maxMs: number
  readonly p95SinceBlockMs: number | undefined
}

export function summarize(latencies: readonly Latency[], sent: number): PanelMeasure {
  const confirmed = latencies.map((l) => l.sinceConfirmedMs)
  const block = latencies.flatMap((l) => (l.sinceBlockMs === undefined ? [] : [l.sinceBlockMs]))
  return {
    sent,
    arrived: latencies.length,
    faithful: latencies.filter((l) => l.faithful).length,
    p50Ms: percentile(confirmed, 50),
    p95Ms: percentile(confirmed, 95),
    maxMs: confirmed.length === 0 ? Number.NaN : Math.max(...confirmed),
    p95SinceBlockMs: block.length === latencies.length ? percentile(block, 95) : undefined,
  }
}

export type SentWithExpectation = {
  readonly landed: Landed | Refused
  readonly expect: Expectation
}

/** Pairs what was sent with what arrived; a transaction the stream never showed is not a latency. */
export function latencies(
  sent: readonly SentWithExpectation[],
  arrivals: ReadonlyMap<string, Arrival>,
): Latency[] {
  return sent.flatMap(({ landed, expect }) => {
    const arrival = arrivals.get(landed.signature)
    return arrival === undefined ? [] : [latencyOf(landed, arrival, expect)]
  })
}
