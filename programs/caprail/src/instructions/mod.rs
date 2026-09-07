//! Інструкції — по файлу на кожну; `lib.rs` лише реєструє їх у `#[program]`.
//!
//! Реекспорт `*` тут обов'язковий: `#[program]` шукає згенеровані модулі
//! `__client_accounts_*` у корені крейта. Тому хендлери названі по інструкції,
//! а не однаково `handler` — два `handler` під одним glob дають неоднозначне
//! ім'я, а це попередження, яке під `-D warnings` валить гейт.

pub mod create_company;
pub mod create_token;
pub mod set_investor_status;
pub mod set_policy;
pub mod set_roles;

pub use create_company::*;
pub use create_token::*;
pub use set_investor_status::*;
pub use set_policy::*;
pub use set_roles::*;
