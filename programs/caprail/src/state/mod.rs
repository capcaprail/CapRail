//! Акаунти стану — PDA програми, всі фіксованого розміру (без `Vec`), щоб хук
//! читав їх зі зрізу без алокацій, а індекс і TS-клієнт знали розкладку наперед.
//!
//! Seeds тут — єдине місце правди: тести, `ExtraAccountMetaList` (T018) і
//! `packages/chain/pda.ts` виводять адреси тією самою формулою.

pub mod company;
pub mod investor_record;
pub mod token_config;

pub use company::*;
pub use investor_record::*;
pub use token_config::*;

/// Дискримінатор Anchor перед даними кожного `#[account]`.
pub const DISCRIMINATOR_LEN: usize = 8;
