use anchor_lang::prelude::*;

use super::DISCRIMINATOR_LEN;

// Статус допуску. Запис без допуску (`None`) і запис із відкликаним — обидва
// не пропускають переказ; різниця потрібна лише реєстру і звітам.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub enum InvestorStatus {
    None,
    Approved,
    Revoked,
}

// Запис реєстру інвесторів (FR-003) — на пару (mint, гаманець): той самий
// гаманець у двох компаніях — два записи. Створює і оновлює лише
// `compliance_officer` (FR-004); хук лише читає. Відсутність PDA хук трактує
// як «не допущений».
#[account]
#[derive(InitSpace)]
pub struct InvestorRecord {
    pub mint: Pubkey,
    pub wallet: Pubkey,
    pub status: InvestorStatus,
    // Строк дії допуску (unix); хук вимагає `expires_at > now`.
    pub expires_at: i64,
    // Довідкові поля для звітів (FR-002): переказ по них не блокується.
    pub jurisdiction: [u8; 2],
    pub investor_type: u8,
    pub updated_at: i64,
    pub updated_by: Pubkey,
    pub bump: u8,
}

impl InvestorRecord {
    pub const SEED: &'static [u8] = b"investor";
    pub const SPACE: usize = DISCRIMINATOR_LEN + Self::INIT_SPACE;

    pub fn find_address(mint: &Pubkey, wallet: &Pubkey) -> (Pubkey, u8) {
        Pubkey::find_program_address(&[Self::SEED, mint.as_ref(), wallet.as_ref()], &crate::ID)
    }
}
