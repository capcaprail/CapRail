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
}
