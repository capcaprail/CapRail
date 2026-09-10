// The environment of a run: the node, the program, the keys, the money.
//
// Keys are generated for every run and stored nowhere. The demo creates its own
// company from nothing — a persistent key would make the second run start from a
// state the first one left behind, and the criteria are about a clean account.
// `--payer` does not change that: a named wallet only tops the fresh keys up in
// place of the faucet; the disposable keys still sign and own everything.
import { readFileSync } from 'node:fs'
import { type CaprailProgram, createCaprailProgram } from '@caprail/chain'
import {
  Connection,
  type FetchFn,
  Keypair,
  LAMPORTS_PER_SOL,
  type PublicKey,
  SystemProgram,
} from '@solana/web3.js'
import { submit } from './send.ts'

export type DemoKeys = {
  /** Administrator: creates the company and the token, pays for the distribution. */
  readonly admin: Keypair
  /** Compliance officer: the only key that sets investor statuses. */
  readonly complianceOfficer: Keypair
  /** Two admitted investors; transfers between them are the SC-002 set. */
  readonly alice: Keypair
  readonly bob: Keypair
  /** Never registered — the demo's "stranger". */
  readonly stranger: Keypair
  /** Registered with status `none`: in the registry, not admitted. */
  readonly pending: Keypair
  /** Admitted, then revoked. */
  readonly revoked: Keypair
  /** Admitted with an expiry the chain clock has already passed. */
  readonly expired: Keypair
}

export type DemoContext = {
  readonly connection: Connection
  readonly program: CaprailProgram
  readonly keys: DemoKeys
  readonly rpcUrl: string
  readonly local: boolean
}

export function newKeys(): DemoKeys {
  return {
    admin: Keypair.generate(),
    complianceOfficer: Keypair.generate(),
    alice: Keypair.generate(),
    bob: Keypair.generate(),
    stranger: Keypair.generate(),
    pending: Keypair.generate(),
    revoked: Keypair.generate(),
    expired: Keypair.generate(),
  }
}

/**
 * Request budget against a public node: burst and refill.
 *
 * Public devnet cuts at roughly 100 requests per 10 s overall and 40 per 10 s per
 * method; a full run is a few hundred transactions and as many reads. Without a
 * limit the measurement shows `429`, not the rule: the refusal arrives from the
 * node instead of the program and lands in the report as "attempt not sent".
 * A bucket rather than a fixed interval, so the short story is not taxed and only
 * the long measurement loops are paced. Three per second is below the smaller
 * counter even when every request hits the same method.
 */
const NODE_LIMIT = { burst: 30, perSecond: 3 } as const

export const isLocal = (rpcUrl: string): boolean =>
  rpcUrl.includes('127.0.0.1') || rpcUrl.includes('localhost')

// `fetch` with a token bucket; `limit === undefined` means unpaced. The queue keeps
// two concurrent requests from taking the same token twice. web3.js retries `429`
// on its own, and those retries take tokens too — otherwise the backoff would speed
// up exactly what it backs off from.
function pacedFetch(limit: { burst: number; perSecond: number } | undefined): FetchFn {
  let queue: Promise<void> = Promise.resolve()
  let tokens = limit?.burst ?? 0
  let filled = Date.now()

  const take = async (rate: { burst: number; perSecond: number }): Promise<void> => {
    const now = Date.now()
    tokens = Math.min(rate.burst, tokens + ((now - filled) / 1000) * rate.perSecond)
    filled = now
    if (tokens < 1) {
      await new Promise((resolve) => setTimeout(resolve, ((1 - tokens) / rate.perSecond) * 1000))
      filled = Date.now()
    }
    tokens = Math.max(0, tokens - 1)
  }

  const paced = async (input: unknown, init: unknown): Promise<unknown> => {
    if (limit !== undefined) {
      const turn = queue.then(() => take(limit))
      queue = turn
      await turn
    }
    return await fetch(input as string, init as RequestInit)
  }

  // `FetchFn` is typed after node-fetch while the runtime is Node's global `fetch`;
  // the cast sits on that boundary and nowhere else.
  return paced as unknown as FetchFn
}

export function createContext(rpcUrl: string): DemoContext {
  const local = isLocal(rpcUrl)
  const connection = new Connection(rpcUrl, {
    commitment: 'confirmed',
    fetch: pacedFetch(local ? undefined : NODE_LIMIT),
  })
  return { connection, program: createCaprailProgram(connection), keys: newKeys(), rpcUrl, local }
}

/**
 * A `solana-keygen` file: a JSON array of 64 bytes. Checked here rather than by the
 * first transaction — "invalid signature" five minutes into a run says nothing
 * about the file.
 */
export function loadKeypair(path: string): Keypair {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (!Array.isArray(parsed) || parsed.length !== 64) {
    throw new Error(`${path}: expected a solana keypair file — a JSON array of 64 bytes`)
  }
  return Keypair.fromSecretKey(Uint8Array.from(parsed as number[]))
}

/**
 * Puts SOL on an address: from the named wallet, or from the faucet.
 *
 * Locally the airdrop is free and instant. On devnet it is rationed, which is what
 * `--payer` is for: the deploy wallet already has funds. A failed airdrop does not
 * stop the run — whether the money suffices is for the first transaction to say. A
 * failed transfer from a named wallet does: that is a launch error, not a network
 * property.
 */
export async function fund(
  connection: Connection,
  address: PublicKey,
  sol: number,
  payer: Keypair | undefined,
): Promise<boolean> {
  if (payer !== undefined) {
    await submit(
      connection,
      payer.publicKey,
      [
        SystemProgram.transfer({
          fromPubkey: payer.publicKey,
          toPubkey: address,
          lamports: Math.round(sol * LAMPORTS_PER_SOL),
        }),
      ],
      [payer],
    )
    return true
  }
  try {
    const signature = await connection.requestAirdrop(address, sol * LAMPORTS_PER_SOL)
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash()
    await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed')
    return true
  } catch {
    return false
  }
}

export const solOf = (lamports: number): string => (lamports / LAMPORTS_PER_SOL).toFixed(6)

/**
 * Time as the **program** sees it. `Clock::unix_timestamp` is derived from slots and
 * lags the host clock when the validator has run longer than one session; an expiry
 * computed from `Date.now()` can already be in the past for the hook.
 * `getBlockTime` is `null` on a slot without a time yet; the host clock is the
 * fallback — worse, but better than stopping.
 */
export async function chainTime(connection: Connection): Promise<number> {
  const slot = await connection.getSlot('confirmed')
  const time = await connection.getBlockTime(slot)
  return time ?? Math.floor(Date.now() / 1000)
}

/** Waits until the chain clock is past `unixSeconds` (strictly, as the hook compares). */
export async function waitChainTimePast(
  connection: Connection,
  unixSeconds: number,
): Promise<void> {
  for (;;) {
    if ((await chainTime(connection)) > unixSeconds) return
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
}

/** `fn` over `items` with at most `limit` in flight; results in input order. */
export async function mapConcurrent<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++
      if (index >= items.length) return
      const item = items[index]
      if (item === undefined) return
      results[index] = await fn(item, index)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}
