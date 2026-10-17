//! Акаунти стану — PDA програми, всі фіксованого розміру (без `Vec`), щоб хук
//! читав їх зі зрізу без алокацій, а індекс і TS-клієнт знали розкладку наперед.
//!
//! Seeds тут — єдине місце правди: тести, `ExtraAccountMetaList` (T018) і
//! `packages/chain/pda.ts` виводять адреси тією самою формулою.

pub mod company;
pub mod grant;
pub mod investor_record;
pub mod offer;
pub mod platform_config;
pub mod token_config;

pub use company::*;
pub use grant::*;
pub use investor_record::*;
pub use offer::*;
pub use platform_config::*;
pub use token_config::*;

/// Дискримінатор Anchor перед даними кожного `#[account]`.
pub const DISCRIMINATOR_LEN: usize = 8;

// Seeds already baked into the `ExtraAccountMetaList` of every issued token.
// `Grant` takes its seed from here, and `TransferPermit` (US4) must too —
// otherwise the hook would look for the account at one address while the
// instruction creates it at another.
pub const GRANT_SEED: &[u8] = b"grant";
pub const PERMIT_SEED: &[u8] = b"permit";
