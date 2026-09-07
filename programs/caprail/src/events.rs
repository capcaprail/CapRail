//! Anchor-події — єдине, що читає індекс (worker). Він не дивиться на акаунти
//! транзакції, тому кожна подія несе все, що потрібно для рядка в БД.

use anchor_lang::prelude::*;

use crate::state::{InvestorStatus, TransferPolicy};

#[event]
pub struct CompanyCreated {
    pub company: Pubkey,
    pub company_id: u64,
    pub admin: Pubkey,
    pub compliance_officer: Pubkey,
    pub name: String,
}

// Єдине, з чого worker дізнається про новий mint: акаунтів транзакції він не
// читає. Тому тут і казначейство, і початкова політика.
#[event]
pub struct TokenCreated {
    pub company: Pubkey,
    pub mint: Pubkey,
    pub treasury: Pubkey,
    pub name: String,
    pub symbol: String,
    pub decimals: u8,
    pub total_supply: u64,
    pub policy: TransferPolicy,
    pub policy_version: u32,
}

// Історія політики в індексі ведеться по `policy_version`; `set_at` тут, щоб
// рядок історії не залежав від `block_time` транзакції.
#[event]
pub struct PolicySet {
    pub company: Pubkey,
    pub mint: Pubkey,
    pub policy: TransferPolicy,
    pub policy_version: u32,
    pub set_at: i64,
}

#[event]
pub struct RolesSet {
    pub company: Pubkey,
    pub admin: Pubkey,
    pub compliance_officer: Pubkey,
    pub set_at: i64,
}

// Реєстр інвесторів індекс веде лише з цієї події: і поточний стан
// (`investors`), і історію (`investor_status_events`) — звідси ж `updated_by`.
#[event]
pub struct InvestorStatusSet {
    pub company: Pubkey,
    pub mint: Pubkey,
    pub wallet: Pubkey,
    pub status: InvestorStatus,
    pub expires_at: i64,
    pub jurisdiction: [u8; 2],
    pub investor_type: u8,
    pub updated_at: i64,
    pub updated_by: Pubkey,
}
