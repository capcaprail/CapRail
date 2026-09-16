// The US1 demo and the M1 measurements (T025).
//
// Run against a local validator with both programs in genesis
// (`scripts/wsl-localnet.sh start`, from PowerShell through `wsl.exe`):
//   pnpm demo:us1
//   pnpm demo:us1 -- --dump fixtures/logs        # also save fixtures for T027
//   pnpm demo:us1 -- --rpc https://api.devnet.solana.com --payer <keypair.json>
//   pnpm demo:us1 -- --rpc … --payer … --api http://localhost:8787   # + SC-003/004/008
//
// Options:
//   --rpc <url>       node, default http://127.0.0.1:8899; `devnet` takes
//                     DEVNET_RPC_URL from the environment (.env) — the same node
//                     the worker reads, and its key stays out of the command line
//   --payer <file>    wallet that funds the disposable keys instead of the faucet;
//                     what they do not spend is sent back at the end
//   --count <n>       transfers per criterion, default 100 (SC-001: n/4 per kind)
//   --dump <dir>      write one JSON fixture per transaction kind into <dir>
//   --api <url>       the API in front of a worker on the same node: sign in as the
//                     admin, listen to the event stream, measure the panel's delay
//
// The exit code is the verdict: 0 when every criterion holds, 1 otherwise — so a
// devnet run (T032) can be gated the same way as the tests.
import { resolve } from 'node:path'
import { LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js'
import { createContext, type DemoContext, loadKeypair, solOf } from './context.ts'
import { toFixture, writeFixture } from './dump.ts'
import {
  KINDS,
  type Measurements,
  measureAdmission,
  measureAllowed,
  measurePropagation,
  secondsPerSlot,
} from './measure.ts'
import {
  capTable,
  type Feed,
  latencies,
  openFeed,
  type PanelClient,
  type PanelMeasure,
  summarize,
  waitIndexed,
} from './measure-panel.ts'
import { fundKeys, refundKeys, runUs1, tokenBalance, type Us1Result } from './scenarios/us1.ts'

type Options = {
  readonly rpc: string
  readonly payer: string | undefined
  readonly count: number
  readonly dump: string | undefined
  readonly api: string | undefined
}

function parseArgs(argv: readonly string[]): Options {
  const value = (flag: string): string | undefined => {
    const index = argv.indexOf(flag)
    return index === -1 ? undefined : argv[index + 1]
  }
  const dump = value('--dump')
  const count = Number(value('--count') ?? 100)
  if (!Number.isInteger(count) || count < 4) throw new Error('--count must be an integer ≥ 4')
  return {
    rpc: rpcOf(value('--rpc')),
    payer: value('--payer'),
    count,
    // pnpm runs the script inside `tools/demo`; a relative path means "from where the
    // command was typed", which is what `INIT_CWD` carries.
    dump: dump === undefined ? undefined : resolve(process.env.INIT_CWD ?? process.cwd(), dump),
    api: value('--api')?.replace(/\/$/, ''),
  }
}

function rpcOf(flag: string | undefined): string {
  if (flag === undefined) return 'http://127.0.0.1:8899'
  if (flag !== 'devnet') return flag
  const url = process.env.DEVNET_RPC_URL
  if (url === undefined || url === '')
    throw new Error('--rpc devnet needs DEVNET_RPC_URL in the environment')
  return url
}

/** The node as it may be printed: a Helius URL carries its key in the query string. */
function describeUrl(url: string): string {
  try {
    const parsed = new URL(url)
    return parsed.search === '' ? url : `${parsed.origin}${parsed.pathname}?…`
  } catch {
    return url
  }
}

// Budgets from the M1 table (TASKS.md). SC-002 is "≥ 99 of 100" — a ratio, so it
// scales with `--count`.
const BUDGET = {
  allowedRatio: 0.99,
  transferLamports: 0.001 * LAMPORTS_PER_SOL,
  propagationSeconds: 10,
  panelSeconds: 5,
  demoSeconds: 180,
} as const

/** How long the panel gets to catch up after the last transaction before the count is final. */
const FEED_SETTLE_MS = 60_000
const INDEX_TIMEOUT_MS = 120_000

/** What the panel showed of the run: the SC-003/SC-004 numbers and SC-008's clock. */
type Panel = {
  readonly allowed: PanelMeasure
  readonly refused: PanelMeasure
  /** The cap table the API serves equals the balances on chain, holder by holder. */
  readonly capTableMatchesChain: boolean
  /** Story wall time plus the wait until the index served the company: SC-008. */
  readonly storySeconds: number
  readonly indexSeconds: number
}

const log = (line: string): void => {
  console.log(line)
}

const seconds = (ms: number): string => (ms / 1000).toFixed(2)

function panelChecks(panel: Panel | undefined): [string, boolean][] {
  if (panel === undefined) return []
  const complete = (p: PanelMeasure): boolean =>
    p.arrived === p.sent && p.faithful === p.sent && p.p95Ms <= BUDGET.panelSeconds * 1000
  return [
    ['SC-003', complete(panel.allowed) && panel.capTableMatchesChain],
    ['SC-004', complete(panel.refused)],
    ['SC-008', panel.storySeconds + panel.indexSeconds <= BUDGET.demoSeconds],
  ]
}

function reportPanel(
  panel: Panel,
  mark: (name: string) => string,
  log: (line: string) => void,
): void {
  const line = (p: PanelMeasure): string =>
    `p95 ${seconds(p.p95Ms)} s (p50 ${seconds(p.p50Ms)}, max ${seconds(p.maxMs)}) after confirmation, ` +
    `${p.arrived}/${p.sent} seen on the stream, ${p.faithful} faithful` +
    (p.p95SinceBlockMs === undefined ? '' : `; from blockTime p95 ${seconds(p.p95SinceBlockMs)} s`)
  log(`${mark('SC-003')} SC-003 cap table updated: ${line(panel.allowed)}`)
  log(
    `       cap table equals chain balances: ${panel.capTableMatchesChain}; budget ${BUDGET.panelSeconds} s p95`,
  )
  log(`${mark('SC-004')} SC-004 refusal in the journal with its reason: ${line(panel.refused)}`)
  log(
    `${mark('SC-008')} SC-008 end-to-end: story ${panel.storySeconds.toFixed(1)} s + index ${panel.indexSeconds.toFixed(1)} s ` +
      `= ${(panel.storySeconds + panel.indexSeconds).toFixed(1)} s, budget ${BUDGET.demoSeconds} s`,
  )
}

function report(us1: Us1Result, m: Measurements, panel: Panel | undefined): boolean {
  const { admission, allowed, propagation } = m
  const maxFee = Math.max(...allowed.feeLamports)
  const worstPropagation = Math.max(...propagation.map((p) => p.wallMs)) / 1000
  const checks: readonly [string, boolean][] = [
    ['SC-001', admission.refused === admission.attempts && admission.balancesUnchanged],
    ['SC-002', allowed.passed >= allowed.attempts * BUDGET.allowedRatio],
    ['SC-010', maxFee <= BUDGET.transferLamports],
    [
      'SC-011',
      propagation.every((p) => p.verdict === (p.change === 'revoke' ? 'refused' : 'passed')) &&
        worstPropagation <= BUDGET.propagationSeconds,
    ],
    ...panelChecks(panel),
  ]
  const mark = (name: string): string => (checks.find(([n]) => n === name)?.[1] ? 'OK  ' : 'FAIL')

  log('')
  log('── M1 measurements ──')
  log(
    `${mark('SC-001')} SC-001 refused ${admission.refused}/${admission.attempts} transfers to non-admitted wallets; ` +
      `balances unchanged: ${admission.balancesUnchanged}`,
  )
  for (const kind of KINDS) {
    const k = admission.byKind[kind]
    log(`       ${kind.padEnd(12)} ${k.refused} refused, reason ${k.sample?.reason ?? '—'}`)
  }
  if (admission.passed.length > 0) log(`       PASSED THROUGH: ${admission.passed.join(', ')}`)
  log(
    `${mark('SC-002')} SC-002 passed ${allowed.passed}/${allowed.attempts} transfers between admitted investors` +
      (allowed.refused.length > 0 ? ` — refused: ${allowed.refused.join(', ')}` : ''),
  )
  log(
    `${mark('SC-010')} SC-010 fee per compliant transfer: max ${maxFee} lamports (${solOf(maxFee)} SOL), ` +
      `budget ${BUDGET.transferLamports}; sender paid ${allowed.senderLamportsDelta} lamports for ${allowed.passed} transfers` +
      ` (${allowed.senderLamportsDelta === allowed.feeLamports.reduce((a, b) => a + b, 0) ? 'fees only' : 'MORE THAN FEES'})`,
  )
  log(`       refused transfer also pays: ${Math.max(...admission.feeLamports)} lamports`)
  log(`${mark('SC-011')} SC-011 status change → next transfer:`)
  for (const p of propagation) {
    log(
      `       ${p.change.padEnd(8)} → ${p.verdict.padEnd(7)} (${p.reason ?? 'TransferAllowed'}): ` +
        `${p.slots} slots (${p.statusSlot} → ${p.transferSlot}), chain ${p.chainSeconds ?? '?'} s, wall ${(p.wallMs / 1000).toFixed(2)} s`,
    )
  }
  log(
    `       seconds per slot this run: ${m.secondsPerSlot === undefined ? '?' : m.secondsPerSlot.toFixed(3)}`,
  )
  if (panel !== undefined) reportPanel(panel, mark, log)
  log('')
  log(
    `mint ${us1.token.mint.toBase58()} · refused in explorer: ${us1.transactions.transferRefused.signature}`,
  )
  return checks.every(([, ok]) => ok)
}

/** The story and the measurements; the verdict is the return value. */
async function run(ctx: DemoContext, options: Options, network: string): Promise<boolean> {
  log('── US1 story ──')
  const started = Date.now()
  const us1 = await runUs1(ctx, log)
  const storySeconds = (Date.now() - started) / 1000
  log(`  story took ${storySeconds.toFixed(1)} s`)

  // The stream is opened before the measurements so every one of their
  // transactions can be attributed; the story itself is only waited for.
  let observer: { client: PanelClient; feed: Feed; indexSeconds: number } | undefined
  if (options.api !== undefined) {
    log(`── panel: ${options.api} ──`)
    const waited = Date.now()
    const client = await waitIndexed(
      options.api,
      ctx.keys.admin,
      String(us1.companyId),
      INDEX_TIMEOUT_MS,
    )
    const indexSeconds = (Date.now() - waited) / 1000
    const feed = await openFeed(client, String(us1.companyId))
    observer = { client, feed, indexSeconds }
    log(
      `  signed in as admin; index served the company ${indexSeconds.toFixed(1)} s after the story; stream open`,
    )
  }

  log('── SC-001: transfers to non-admitted wallets ──')
  const admission = await measureAdmission(ctx, us1.token, ctx.keys.alice, options.count / 4, log)
  log(`  ${admission.refused}/${admission.attempts} refused`)
  log('── SC-002 / SC-010: transfers between admitted investors ──')
  const allowed = await measureAllowed(
    ctx,
    us1.token,
    ctx.keys.alice,
    ctx.keys.bob.publicKey,
    options.count,
  )
  log(`  ${allowed.passed}/${allowed.attempts} passed`)
  log('── SC-011: status change → next transfer ──')
  const propagation = await measurePropagation(
    ctx,
    us1.token,
    ctx.keys.alice,
    ctx.keys.bob.publicKey,
  )
  const last = propagation.at(-1)
  const measurements: Measurements = {
    admission,
    allowed,
    propagation,
    secondsPerSlot:
      last === undefined
        ? undefined
        : secondsPerSlot(us1.transactions.createCompany, {
            slot: last.transferSlot,
            blockTime: last.transferBlockTime,
          }),
  }

  let panel: Panel | undefined
  if (observer !== undefined) {
    const { client, feed, indexSeconds } = observer
    const sent = [
      ...allowed.landed.map((landed) => ({
        landed,
        expect: { outcome: 'allowed' as const, destOwner: ctx.keys.bob.publicKey.toBase58() },
      })),
      ...admission.refusals.map(({ recipient, refused }) => ({
        landed: refused,
        expect: { outcome: 'rejected' as const, destOwner: recipient },
      })),
    ]
    log('── panel: waiting for the stream to catch up ──')
    const seen = await feed.waitFor(
      sent.map((s) => s.landed.signature),
      FEED_SETTLE_MS,
    )
    log(`  ${seen}/${sent.length} attempts arrived`)
    feed.close()
    const served = await capTable(client, String(us1.companyId), us1.token.mint.toBase58())
    const onChain = await Promise.all(
      served.holders.map(async (h) => ({
        wallet: h.wallet,
        served: BigInt(h.amount),
        chain: await tokenBalance(ctx, us1.token, new PublicKey(h.wallet)),
      })),
    )
    panel = {
      allowed: summarize(
        latencies(
          sent.filter((s) => s.expect.outcome === 'allowed'),
          feed.arrivals,
        ),
        allowed.landed.length,
      ),
      refused: summarize(
        latencies(
          sent.filter((s) => s.expect.outcome === 'rejected'),
          feed.arrivals,
        ),
        admission.refusals.length,
      ),
      capTableMatchesChain: onChain.length === 2 && onChain.every((h) => h.served === h.chain),
      storySeconds,
      indexSeconds,
    }
  }

  const ok = report(us1, measurements, panel)

  if (options.dump !== undefined) {
    const t = us1.transactions
    const fixtures = [
      toFixture('create-company', network, t.createCompany),
      toFixture('create-token', network, t.createToken),
      toFixture('set-policy', network, t.setPolicy),
      toFixture('set-investor-status', network, t.setInvestorStatus),
      toFixture('distribute', network, t.distribute),
      toFixture('transfer-allowed', network, t.transferAllowed),
      toFixture('transfer-refused-not-accredited', network, t.transferRefused),
    ]
    const expired = admission.byKind.expired.sample
    if (expired !== undefined)
      fixtures.push(toFixture('transfer-refused-expired', network, expired))
    for (const fixture of fixtures) log(`fixture ${writeFixture(options.dump, fixture)}`)
  }

  return ok
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  const ctx = createContext(options.rpc)
  const payer = options.payer === undefined ? undefined : loadKeypair(options.payer)

  try {
    await ctx.connection.getVersion()
  } catch {
    throw new Error(
      `no node at ${describeUrl(options.rpc)} — locally: wsl.exe -e bash /mnt/<disk>/<repo>/scripts/wsl-localnet.sh start`,
    )
  }
  const network = ctx.local ? 'localnet' : describeUrl(options.rpc)
  log(`node ${network}, ${options.count} transfers per criterion`)

  log('funding disposable keys…')
  await fundKeys(ctx, payer, log)

  // The refund runs whether the run finished or fell over halfway: a run that
  // died on a rate limit must not also cost the funding of four keys.
  try {
    process.exitCode = (await run(ctx, options, network)) ? 0 : 1
  } finally {
    if (payer !== undefined) {
      const refunded = await refundKeys(ctx, payer, log)
      log(`refunded ${solOf(refunded)} SOL to ${payer.publicKey.toBase58()}`)
    }
  }
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
