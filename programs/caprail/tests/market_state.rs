//! `PlatformConfig` і `Offer` (T034): арифметика комісії й оплати, межі умов
//! пропозиції, похідний стан «у вікні ROFR». Інструкцій ще немає (T035–T037),
//! тож тут — лише методи стану; TS-дубль розрахунку комісії (T041) звірятиметься
//! з цими ж числами.

use anchor_lang::prelude::Pubkey;
use caprail::state::{Offer, OfferStatus, PlatformConfig, BPS_DENOMINATOR, FEE_BPS_MAX};
use caprail::CaprailError;

fn platform(fee_bps: u16) -> PlatformConfig {
    PlatformConfig {
        authority: Pubkey::new_unique(),
        payment_mint: Pubkey::new_unique(),
        fee_treasury: Pubkey::new_unique(),
        fee_bps,
        bump: 255,
    }
}

fn offer(amount: u64, remaining: u64, price_per_unit: u64, rofr_until: i64) -> Offer {
    Offer {
        mint: Pubkey::new_unique(),
        seller: Pubkey::new_unique(),
        offer_id: 1,
        amount,
        remaining,
        price_per_unit,
        rofr_until,
        status: OfferStatus::Open,
        created_at: 1_700_000_000,
        bump: 254,
    }
}

fn error_code(result: anchor_lang::Result<()>) -> u32 {
    match result {
        Err(anchor_lang::error::Error::AnchorError(e)) => e.error_code_number,
        other => panic!("expected an Anchor error, got {other:?}"),
    }
}

#[test]
fn fee_is_rounded_down_and_never_exceeds_the_nominal_share() {
    let one_percent = platform(100);
    assert_eq!(one_percent.fee_for(1_000_000), 10_000);
    // 99 × 100 / 10 000 = 0,99 → 0: дрібна угода може дати нуль комісії.
    assert_eq!(one_percent.fee_for(99), 0);
    assert_eq!(one_percent.fee_for(0), 0);
    assert_eq!(platform(0).fee_for(u64::MAX), 0);
    // Стеля: 10 % від максимуму не переповнюється і не перевищує номінал.
    let ceiling = platform(FEE_BPS_MAX);
    assert_eq!(
        ceiling.fee_for(u64::MAX),
        (u128::from(u64::MAX) * u128::from(FEE_BPS_MAX) / u128::from(BPS_DENOMINATOR)) as u64
    );
    assert!(ceiling.fee_for(u64::MAX) <= u64::MAX / 10);
}

#[test]
fn fee_bps_is_capped() {
    assert!(PlatformConfig::validate_fee_bps(0).is_ok());
    assert!(PlatformConfig::validate_fee_bps(FEE_BPS_MAX).is_ok());
    assert_eq!(
        error_code(PlatformConfig::validate_fee_bps(FEE_BPS_MAX + 1)),
        u32::from(CaprailError::InvalidFee)
    );
}

#[test]
fn offer_terms_reject_zero_and_overflow() {
    assert!(Offer::validate_terms(1, 1).is_ok());
    assert!(Offer::validate_terms(u64::MAX, 1).is_ok());
    for (amount, price) in [(0, 10), (10, 0), (0, 0), (u64::MAX, 2), (1 << 32, 1 << 32)] {
        assert_eq!(
            error_code(Offer::validate_terms(amount, price)),
            u32::from(CaprailError::InvalidOffer),
            "amount {amount}, price {price}"
        );
    }
}

#[test]
fn payment_is_exact_on_partial_fills_and_bounded_by_remaining() {
    let offer = offer(1_000, 400, 250_000, 0);
    assert_eq!(offer.payment_for(400), Some(100_000_000));
    assert_eq!(offer.payment_for(1), Some(250_000));
    // Понад залишок або нуль — не угода.
    assert_eq!(offer.payment_for(401), None);
    assert_eq!(offer.payment_for(0), None);
    // Частини сумуються в оплату за ціле без залишку від округлення.
    let whole = offer.payment_for(400).unwrap();
    let parts: u64 = [150, 150, 100]
        .iter()
        .map(|part| offer.payment_for(*part).unwrap())
        .sum();
    assert_eq!(parts, whole);
    // Комісія з кожної частини не більша за комісію з цілого.
    let fee = platform(250);
    let fee_parts: u64 = [150, 150, 100]
        .iter()
        .map(|part| fee.fee_for(offer.payment_for(*part).unwrap()))
        .sum();
    assert!(fee_parts <= fee.fee_for(whole));
}

#[test]
fn rofr_window_is_derived_from_time_and_status() {
    let now = 1_700_000_100;
    let no_window = offer(10, 10, 1, 0);
    assert!(no_window.is_open());
    assert!(!no_window.in_rofr_window(now));

    let open_window = offer(10, 10, 1, now + 1);
    assert!(open_window.in_rofr_window(now));
    assert!(!open_window.in_rofr_window(now + 1));

    // Закрита пропозиція не «у вікні», хоч би час і не вийшов.
    let mut cancelled = offer(10, 10, 1, now + 100);
    cancelled.status = OfferStatus::Cancelled;
    assert!(!cancelled.is_open());
    assert!(!cancelled.in_rofr_window(now));
    let mut filled = offer(10, 0, 1, now + 100);
    filled.status = OfferStatus::Filled;
    assert!(!filled.in_rofr_window(now));
    assert_eq!(filled.payment_for(1), None);
}
