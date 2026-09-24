//! Коди відмов. Перші чотири — причини FR-006 у порядку перевірок хука; їхні
//! імена дзеркалить `REJECTION_REASONS` у `packages/shared` (guard-тест звіряє
//! з IDL). Решта — службові: не про переказ, а про виклик інструкції.

use anchor_lang::prelude::*;

#[error_code]
pub enum CaprailError {
    #[msg("recipient is not an accredited investor of this company")]
    NotAccredited,
    #[msg("recipient's accreditation has expired")]
    AccreditationExpired,
    #[msg("amount exceeds the vested balance of the sender")]
    Unvested,
    #[msg("transfer must go through an offer while the ROFR window is open")]
    RofrWindowOpen,

    #[msg("signer does not hold the role required by this instruction")]
    Unauthorized,
    #[msg("hook must be invoked by the token program during a transfer")]
    NotTransferring,
    #[msg("token config does not belong to the transferred mint")]
    TokenConfigMismatch,
    #[msg("ROFR is not available in this version")]
    RofrNotSupported,
    #[msg("admin and compliance officer must be two different, non-zero keys")]
    InvalidRoles,
    #[msg("name must be 1..=32 bytes of UTF-8")]
    InvalidName,
    #[msg("token symbol must be 1..=10 bytes and uri at most 200 bytes of UTF-8")]
    InvalidMetadata,
    #[msg("total supply must be positive and decimals at most 9")]
    InvalidSupply,
    #[msg("policy values are out of range")]
    InvalidPolicy,
    #[msg("jurisdiction must be two uppercase ASCII letters or left unset")]
    InvalidJurisdiction,
    #[msg("an approved investor needs an expiry in the future")]
    InvalidExpiry,
    #[msg("amount must be positive")]
    InvalidAmount,
    #[msg("platform fee must be at most 1000 basis points")]
    InvalidFee,
    #[msg("offer needs a positive amount and price whose product fits in u64")]
    InvalidOffer,
    #[msg("payment mint must transfer the exact amount: no transfer hook, no transfer fee")]
    InvalidPaymentMint,
}
