//! Anchor-події — єдине, що читає індекс (worker). Він не дивиться на акаунти
//! транзакції, тому кожна подія несе все, що потрібно для рядка в БД.

use anchor_lang::prelude::*;

#[event]
pub struct CompanyCreated {
    pub company: Pubkey,
    pub company_id: u64,
    pub admin: Pubkey,
    pub compliance_officer: Pubkey,
    pub name: String,
}
