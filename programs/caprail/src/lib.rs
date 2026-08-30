//! Ончейн-програма CapRail: одна на всіх емітентів, політика — дані в PDA.
//!
//! Правило допуску, vesting і ROFR виконує сам токен: mint компанії створюється
//! з розширенням `TransferHook`, і Token-2022 викликає інструкцію `execute`
//! на кожному `transfer_checked` — зі сторонніх гаманців і з CPI теж.
//! Хук акаунтів не створює; відсутній PDA трактується за змістом (див. `hook`).

use anchor_lang::prelude::*;

pub mod errors;

pub use errors::CaprailError;

declare_id!("As8C4JwSGHd7HPvh5KD1FhhLsQphQ8veSdhipiSRWs7g");

#[program]
pub mod caprail {}
