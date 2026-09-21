//! Акаунти стану — PDA програми, всі фіксованого розміру (без `Vec`), щоб хук
//! читав їх зі зрізу без алокацій, а індекс і TS-клієнт знали розкладку наперед.
//!
//! Seeds тут — єдине місце правди: тести, `ExtraAccountMetaList` (T018) і
//! `packages/chain/pda.ts` виводять адреси тією самою формулою.

pub mod company;
pub mod investor_record;
pub mod offer;
pub mod platform_config;
pub mod token_config;

pub use company::*;
pub use investor_record::*;
pub use offer::*;
pub use platform_config::*;
pub use token_config::*;

/// Дискримінатор Anchor перед даними кожного `#[account]`.
pub const DISCRIMINATOR_LEN: usize = 8;

// Seeds акаунтів, яких ще немає: `Grant` (US3) і `TransferPermit` (T037). Їхні
// адреси вже зашиті в `ExtraAccountMetaList` кожного випущеного токена, тож
// коли структури з'являться, вони зобов'язані взяти seed звідси — інакше хук
// шукатиме акаунт за однією адресою, а інструкція створюватиме за іншою.
pub const GRANT_SEED: &[u8] = b"grant";
pub const PERMIT_SEED: &[u8] = b"permit";
