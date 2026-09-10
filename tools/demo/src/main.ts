// The US1 demo and the M1 measurements (T025).
//
// Run against a local validator with both programs in genesis
// (`scripts/wsl-localnet.sh start`, from PowerShell through `wsl.exe`):
//   pnpm demo:us1
//   pnpm demo:us1 -- --dump fixtures/logs        # also save fixtures for T027
//   pnpm demo:us1 -- --rpc https://api.devnet.solana.com --payer <keypair.json>
//
// Options:
//   --rpc <url>       node, default http://127.0.0.1:8899
//   --payer <file>    wallet that funds the disposable keys instead of the faucet
//   --count <n>       transfers per criterion, default 100 (SC-001: n/4 per kind)
//   --dump <dir>      write one JSON fixture per transaction kind into <dir>
//
// The exit code is the verdict: 0 when every criterion holds, 1 otherwise — so a
// devnet run (T032) can be gated the same way as the tests.
import { resolve } from 'node:path'
import { LAMPORTS_PER_SOL } from '@solana/web3.js'
import { createContext, loadKeypair, solOf } from './context.ts'
import { toFixture, writeFixture } from './dump.ts'
import {
  KINDS,
  type Measurements,
  measureAdmission,
  measureAllowed,
  measurePropagation,
  secondsPerSlot,
} from './measure.ts'
import { fundKeys, runUs1, type Us1Result } from './scenarios/us1.ts'

type Options = {
  readonly rpc: string
  readonly payer: string | undefined
  readonly count: number
  readonly dump: string | undefined
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
    rpc: value('--rpc') ?? 'http://127.0.0.1:8899',
    payer: value('--payer'),
    count,
    // pnpm runs the script inside `tools/demo`; a relative path means "from where the
    // command was typed", which is what `INIT_CWD` carries.
    dump: dump === undefined ? undefined : resolve(process.env.INIT_CWD ?? process.cwd(), dump),
  }
}

// Budgets from the M1 table (TASKS.md). SC-002 is "≥ 99 of 100" — a ratio, so it
// scales with `--count`.
const BUDGET = {
  allowedRatio: 0.99,
  transferLamports: 0.001 * LAMPORTS_PER_SOL,
  propagationSeconds: 10,
} as const

const log = (line: string): void => {
  console.log(line)
}

function report(us1: Us1Result, m: Measurements): boolean {
  const { admission, allowed, propagation } = m
  const maxFee = Math.max(...allowed.feeLamports)
  const worstPropagation = Math.max(...propagation.map((p) => p.wallMs)) / 1000
  const checks = [
    ['SC-001', admission.refused === admission.attempts && admission.balancesUnchanged],
    ['SC-002', allowed.passed >= allowed.attempts * BUDGET.allowedRatio],
    ['SC-010', maxFee <= BUDGET.transferLamports],
    [
      'SC-011',
      propagation.every((p) => p.verdict === (p.change === 'revoke' ? 'refused' : 'passed')) &&
        worstPropagation <= BUDGET.propagationSeconds,
    ],
  ] as const
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
  log('')
  log(
    `mint ${us1.token.mint.toBase58()} · refused in explorer: ${us1.transactions.transferRefused.signature}`,
  )
  return checks.every(([, ok]) => ok)
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  const ctx = createContext(options.rpc)
  const payer = options.payer === undefined ? undefined : loadKeypair(options.payer)

  try {
    await ctx.connection.getVersion()
  } catch {
    throw new Error(
      `no node at ${options.rpc} — locally: wsl.exe -e bash /mnt/<disk>/<repo>/scripts/wsl-localnet.sh start`,
    )
  }
  const network = ctx.local ? 'localnet' : options.rpc
  log(`node ${options.rpc} (${network}), ${options.count} transfers per criterion`)

  log('funding disposable keys…')
  await fundKeys(ctx, payer, log)

  log('── US1 story ──')
  const started = Date.now()
  const us1 = await runUs1(ctx, log)
  log(`  story took ${((Date.now() - started) / 1000).toFixed(1)} s`)

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

  const ok = report(us1, measurements)

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

  process.exitCode = ok ? 0 : 1
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
