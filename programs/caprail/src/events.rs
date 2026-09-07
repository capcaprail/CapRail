//! Anchor-події — єдине, що читає індекс (worker). Він не дивиться на акаунти
//! транзакції, тому кожна подія несе все, що потрібно для рядка в БД.

use anchor_lang::prelude::*;

use crate::state::TransferPolicy;

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
