// The panel's copy of `programs/caprail/src/vesting.rs`: what it shows as vested
// must be exactly what the hook lets through, so the two are held together by
// `fixtures/vesting.json` (SC-005). Bigint because `total` is a u64 and times are
// i64 — and so the product never rounds, as the program's u128 does not.
export function vested(
  total: bigint,
  start: bigint,
  cliff: bigint,
  end: bigint,
  now: bigint,
): bigint | null {
  if (cliff < start || end < cliff || start === end) return null
  if (now < cliff) return 0n
  if (now >= end) return total
  return (total * (now - start)) / (end - start)
}
