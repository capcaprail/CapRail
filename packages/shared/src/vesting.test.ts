import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { vested } from './vesting.ts'

const U64_MAX = 2n ** 64n - 1n
const I64_MIN = -(2n ** 63n)
const I64_MAX = 2n ** 63n - 1n

const FIXTURE = join(import.meta.dirname, '..', '..', '..', 'fixtures', 'vesting.json')
const SEED = 0xc0ffee_5c005n
const SCHEDULES = 50

describe('vested', () => {
  it('40 % of the way from start unlocks 40 %', () => {
    expect(vested(1000n, 0n, 0n, 100n, 40n)).toBe(400n)
  })

  it('rounds down', () => {
    expect(vested(10n, 0n, 0n, 3n, 1n)).toBe(3n)
    expect(vested(10n, 0n, 0n, 3n, 2n)).toBe(6n)
  })

  it('unlocks nothing before the cliff and the accrued part on it', () => {
    expect(vested(1000n, 0n, 25n, 100n, 24n)).toBe(0n)
    expect(vested(1000n, 0n, 25n, 100n, 25n)).toBe(250n)
  })

  it('unlocks everything from the end on', () => {
    expect(vested(1000n, 0n, 0n, 100n, 99n)).toBe(990n)
    expect(vested(1000n, 0n, 0n, 100n, 100n)).toBe(1000n)
    expect(vested(1000n, 0n, 0n, 100n, I64_MAX)).toBe(1000n)
  })

  it('a cliff on the end is all or nothing', () => {
    expect(vested(1000n, 0n, 100n, 100n, 99n)).toBe(0n)
    expect(vested(1000n, 0n, 100n, 100n, 100n)).toBe(1000n)
  })

  it('a schedule over the whole i64 range at u64::MAX stays exact', () => {
    expect(vested(U64_MAX, I64_MIN, I64_MIN, I64_MAX, 0n)).toBe(2n ** 63n)
    expect(vested(U64_MAX, I64_MIN, I64_MIN, I64_MAX, I64_MAX - 1n)).toBe(U64_MAX - 1n)
  })

  it('is null for a schedule that is not one', () => {
    expect(vested(1000n, 10n, 9n, 100n, 50n)).toBeNull()
    expect(vested(1000n, 0n, 101n, 100n, 50n)).toBeNull()
    expect(vested(1000n, 50n, 50n, 50n, 50n)).toBeNull()
  })
})

// SplitMix64: the fixture must come out byte for byte the same on every run and
// every machine, so no `Math.random` and no clock.
function generator(seed: bigint) {
  let state = seed
  const next = (): bigint => {
    state = BigInt.asUintN(64, state + 0x9e3779b97f4a7c15n)
    let z = state
    z = BigInt.asUintN(64, (z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n)
    z = BigInt.asUintN(64, (z ^ (z >> 27n)) * 0x94d049bb133111ebn)
    return z ^ (z >> 31n)
  }
  return { below: (bound: bigint): bigint => next() % bound }
}

const YEAR = 31_536_000n

// Five shapes in turn: an ordinary grant, a cliff on the start, a cliff on the end,
// a total near u64::MAX, and spans near the whole i64 range — the last two are where
// a port without 128-bit (or big) intermediates would part ways with the program.
function schedule(index: number, random: ReturnType<typeof generator>) {
  const kind = index % 5
  if (kind === 4) {
    const start = I64_MIN + 1n + random.below(2n ** 62n)
    const end = I64_MAX - random.below(2n ** 62n)
    const cliff = start + random.below(end - start + 1n)
    return { total: random.below(U64_MAX) + 1n, start, cliff, end }
  }
  const start = 1_700_000_000n + random.below(5n * YEAR)
  const end = start + 1n + random.below(4n * YEAR)
  const cliff = kind === 1 ? start : kind === 2 ? end : start + random.below(end - start + 1n)
  const total = kind === 3 ? U64_MAX - random.below(2n ** 32n) : random.below(10n ** 15n) + 1n
  return { total, start, cliff, end }
}

function buildFixture(): string {
  const random = generator(SEED)
  const schedules = Array.from({ length: SCHEDULES }, (_, index) => {
    const { total, start, cliff, end } = schedule(index, random)
    const moments = [
      cliff - 1n,
      cliff,
      start + random.below(end - start + 1n),
      end - 1n,
      end + random.below(I64_MAX - end + 1n),
    ].map((now) => {
      const unlocked = vested(total, start, cliff, end, now)
      if (unlocked === null) throw new Error(`schedule ${index} is not one`)
      return { now: String(now), vested: String(unlocked) }
    })
    return {
      total: String(total),
      start: String(start),
      cliff: String(cliff),
      end: String(end),
      moments,
    }
  })
  return `${JSON.stringify({ seed: `0x${SEED.toString(16)}`, schedules }, null, 2)}\n`
}

const integer = z
  .string()
  .regex(/^-?\d+$/)
  .transform((text) => BigInt(text))
const fixtureSchema = z.object({
  seed: z.string(),
  schedules: z.array(
    z.object({
      total: integer,
      start: integer,
      cliff: integer,
      end: integer,
      moments: z.array(z.object({ now: integer, vested: integer })).length(5),
    }),
  ),
})

describe('fixtures/vesting.json', () => {
  it('is what the seeded generator produces', async () => {
    await expect(buildFixture()).toMatchFileSnapshot(FIXTURE)
  })

  // Read inside each test: on the run that writes the file it does not exist yet.
  const read = () => fixtureSchema.parse(JSON.parse(readFileSync(FIXTURE, 'utf8'))).schedules
  const moments = () => read().flatMap((s) => s.moments.map((m) => ({ ...s, ...m })))

  it('holds 50 schedules × 5 moments within u64 and i64', () => {
    expect(read()).toHaveLength(SCHEDULES)
    for (const m of moments()) {
      for (const time of [m.start, m.cliff, m.end, m.now]) {
        expect(time >= I64_MIN && time <= I64_MAX).toBe(true)
      }
      expect(m.total > 0n && m.total <= U64_MAX).toBe(true)
    }
  })

  // A guard against a fixture that only ever says 0 or `total`: a broken formula in
  // the linear part would then agree with the program on every case.
  it('reaches every branch of the schedule', () => {
    const all = moments()
    const before = all.filter((m) => m.vested === 0n).length
    const unlocked = all.filter((m) => m.vested === m.total).length
    const between = all.length - before - unlocked
    expect(before).toBeGreaterThanOrEqual(50)
    expect(unlocked).toBeGreaterThanOrEqual(50)
    expect(between).toBeGreaterThanOrEqual(50)
  })

  it('every moment matches vested()', () => {
    for (const m of moments()) {
      expect(vested(m.total, m.start, m.cliff, m.end, m.now), `${m.start}…${m.now}`).toBe(m.vested)
    }
  })
})
