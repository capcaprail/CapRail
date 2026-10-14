//! `vested()` (T046): the schedule the hook enforces and the panel shows (FR-010).
//! Exact points pin the rounding and the boundaries; the property test covers
//! random schedules (SC-005), with a sentinel so it cannot pass on rejected
//! schedules alone.

use std::cell::Cell;

use caprail::vesting::vested;
use proptest::prelude::*;
use proptest::test_runner::{Config, TestCaseError, TestRunner};

const START: i64 = 1_700_000_000;
const YEAR: i64 = 365 * 24 * 60 * 60;

#[test]
fn linear_between_cliff_and_end() {
    let (cliff, end) = (START + YEAR / 4, START + YEAR);
    assert_eq!(
        vested(1_000, START, cliff, end, START + YEAR * 2 / 5),
        Some(400)
    );
    assert_eq!(vested(1_000, START, cliff, end, cliff), Some(250));
    assert_eq!(vested(1_000, START, cliff, end, end - 1), Some(999));
}

#[test]
fn rounds_down() {
    // 10 × 1 / 3 = 3.33…: the hook may never unlock a fraction the panel would not show.
    assert_eq!(vested(10, 0, 0, 3, 1), Some(3));
    assert_eq!(vested(10, 0, 0, 3, 2), Some(6));
    assert_eq!(vested(1, 0, 0, 1_000, 999), Some(0));
}

#[test]
fn nothing_before_the_cliff_everything_from_the_end() {
    let (cliff, end) = (START + YEAR / 4, START + YEAR);
    assert_eq!(vested(1_000, START, cliff, end, START - 1), Some(0));
    assert_eq!(vested(1_000, START, cliff, end, START), Some(0));
    assert_eq!(vested(1_000, START, cliff, end, cliff - 1), Some(0));
    assert_eq!(vested(1_000, START, cliff, end, end), Some(1_000));
    assert_eq!(vested(1_000, START, cliff, end, i64::MAX), Some(1_000));
}

#[test]
fn cliff_at_start_or_at_end() {
    assert_eq!(vested(1_000, START, START, START + 100, START), Some(0));
    assert_eq!(
        vested(1_000, START, START, START + 100, START + 1),
        Some(10)
    );
    // A cliff at the end is an all-or-nothing grant.
    assert_eq!(
        vested(1_000, START, START + 100, START + 100, START + 99),
        Some(0)
    );
    assert_eq!(
        vested(1_000, START, START + 100, START + 100, START + 100),
        Some(1_000)
    );
}

#[test]
fn extreme_values_do_not_overflow() {
    assert_eq!(
        vested(u64::MAX, i64::MIN, i64::MIN, i64::MAX, i64::MAX),
        Some(u64::MAX)
    );
    assert_eq!(
        vested(u64::MAX, i64::MIN, i64::MIN, i64::MAX, i64::MIN),
        Some(0)
    );
    // (2^63 − 1 − i64::MIN) / (2^64 − 1) of u64::MAX = exactly half, rounded down.
    assert_eq!(
        vested(u64::MAX, i64::MIN, i64::MIN, i64::MAX, -1),
        Some(u64::MAX / 2)
    );
    assert_eq!(vested(0, START, START, START + 1, START + 1), Some(0));
}

#[test]
fn malformed_schedule_is_rejected() {
    assert_eq!(vested(1_000, START, START - 1, START + 100, START), None);
    assert_eq!(vested(1_000, START, START + 101, START + 100, START), None);
    assert_eq!(vested(1_000, START, START, START, START), None);
    assert_eq!(vested(1_000, START + 100, START + 100, START, START), None);
}

#[test]
fn properties_hold_on_random_schedules() {
    const CASES: u32 = 1_000;
    // A small negative tail on both offsets yields malformed schedules too,
    // so the rejection path runs inside the same property test.
    let schedule = (
        0..=u64::MAX,
        -(1i64 << 40)..(1i64 << 40),
        -(1i64 << 30)..(1i64 << 35),
        -(1i64 << 30)..(1i64 << 35),
        -(1i64 << 34)..(1i64 << 36),
        -(1i64 << 34)..(1i64 << 36),
    );
    let accepted = Cell::new(0u32);
    let linear = Cell::new(0u32);

    let mut runner = TestRunner::new(Config {
        cases: CASES,
        failure_persistence: None,
        ..Config::default()
    });
    runner
        .run(&schedule, |(total, start, cliff_off, end_off, a, b)| {
            let cliff = start + cliff_off;
            let end = cliff + end_off;
            let (t1, t2) = (start + a.min(b), start + a.max(b));
            let (Some(v1), Some(v2)) = (
                vested(total, start, cliff, end, t1),
                vested(total, start, cliff, end, t2),
            ) else {
                prop_assert!(cliff < start || end < cliff || start == end);
                return Ok(());
            };
            accepted.set(accepted.get() + 1);
            if (cliff..end).contains(&t1) || (cliff..end).contains(&t2) {
                linear.set(linear.get() + 1);
            }

            prop_assert!(v1 <= v2, "not monotonic: {v1} at {t1} > {v2} at {t2}");
            prop_assert!(v2 <= total);
            for (t, v) in [(t1, v1), (t2, v2)] {
                if t < cliff {
                    prop_assert_eq!(v, 0);
                }
                if t >= end {
                    prop_assert_eq!(v, total);
                }
            }
            Ok::<(), TestCaseError>(())
        })
        .unwrap();

    // Without these the properties could pass with every schedule rejected or
    // every moment outside the linear part, where the answer is a constant.
    assert!(
        accepted.get() >= CASES * 9 / 10,
        "only {} of {CASES} schedules accepted",
        accepted.get()
    );
    assert!(
        linear.get() >= CASES / 10,
        "only {} of {CASES} moments in the linear part",
        linear.get()
    );
}
