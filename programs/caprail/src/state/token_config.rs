use anchor_lang::prelude::*;

use super::DISCRIMINATOR_LEN;

// Політика трансферів (FR-002). Один тип для акаунта, аргументів `set_policy`
// і подій — щоб три копії полів не розходились.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub struct TransferPolicy {
    // Одержувач мусить мати чинний допуск (`InvestorRecord::Approved`).
    pub require_accreditation: bool,
    // Продаж — лише через пропозицію з закритим вікном ROFR. До M4 `set_policy`
    // відхиляє `true` (`RofrNotSupported`).
    pub require_rofr: bool,
    pub rofr_window_secs: u32,
}

// Токен капіталу компанії — один акаунт на mint. Його читає хук на кожному
// переказі, тому тут усе, що потрібно правилу, і нічого зайвого.
#[account]
#[derive(InitSpace)]
pub struct TokenConfig {
    pub company: Pubkey,
    pub mint: Pubkey,
    // Власник казначейського ATA. Сьогодні це `company` (PDA), але хук
    // звільняє казначейство від перевірки допуску саме за цим полем — тож
    // перенести казну на інший ключ можна без зміни хука і розкладки.
    pub treasury_owner: Pubkey,
    pub policy: TransferPolicy,
    // Росте на кожен `set_policy`; індекс веде історію версій по ньому.
    pub policy_version: u32,
    pub decimals: u8,
    // Увесь випуск — один раз у `create_token`; більше ніколи не росте.
    pub total_supply: u64,
    pub bump: u8,
}

impl TokenConfig {
    pub const SEED: &'static [u8] = b"token";
    pub const SPACE: usize = DISCRIMINATOR_LEN + Self::INIT_SPACE;

    pub fn find_address(mint: &Pubkey) -> (Pubkey, u8) {
        Pubkey::find_program_address(&[Self::SEED, mint.as_ref()], &crate::ID)
    }
}
