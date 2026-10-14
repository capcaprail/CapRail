//! The vesting schedule of a grant (FR-010). `packages/shared/src/vesting.ts`
//! must compute the same numbers: the panel shows what the hook will allow, and
//! the two are held together by the shared fixtures in `fixtures/vesting.json`.

// Linear from `start`, nothing unlocked before `cliff`, everything from `end`;
// rounded down so the hook never unlocks a fraction of a unit. `None` for a
// schedule that is not one: `cliff` outside `start..=end`, or no duration.
pub fn vested(total: u64, start: i64, cliff: i64, end: i64, now: i64) -> Option<u64> {
    if cliff < start || end < cliff || start == end {
        return None;
    }
    if now < cliff {
        return Some(0);
    }
    if now >= end {
        return Some(total);
    }
    // Spans reach 2^64 − 1 when the schedule covers the whole i64 range; the
    // product of two such values still fits in u128.
    let elapsed = (i128::from(now) - i128::from(start)) as u128;
    let duration = (i128::from(end) - i128::from(start)) as u128;
    Some((u128::from(total) * elapsed / duration) as u64)
}
