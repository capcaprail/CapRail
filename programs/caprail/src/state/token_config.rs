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
    // Mint — теж PDA: адресу виводять панель та індекс, і в браузері транзакцію
    // підписує лише гаманець ролі, без другого тимчасового ключа.
    pub const MINT_SEED: &'static [u8] = b"mint";
    pub const SPACE: usize = DISCRIMINATOR_LEN + Self::INIT_SPACE;

    pub fn find_address(mint: &Pubkey) -> (Pubkey, u8) {
        Pubkey::find_program_address(&[Self::SEED, mint.as_ref()], &crate::ID)
    }

    // Індекс токена — `Company::token_count` на момент створення; наступний
    // токен тієї ж компанії отримує наступний номер і іншу адресу.
    pub fn find_mint_address(company: &Pubkey, token_index: u32) -> (Pubkey, u8) {
        Pubkey::find_program_address(
            &[
                Self::MINT_SEED,
                company.as_ref(),
                &token_index.to_le_bytes(),
            ],
            &crate::ID,
        )
    }
}

// Межі політики. Вікно ROFR довше за місяць замкнуло б продавця на весь час
// вікна — це не політика, а помилка вводу.
pub const ROFR_WINDOW_MAX_SECS: u32 = 30 * 24 * 60 * 60;

impl TransferPolicy {
    // Спільна перевірка для `create_token` і `set_policy`: обидві інструкції
    // приймають політику, і розійтись вони не мають права.
    pub fn validate(&self) -> Result<()> {
        require!(!self.require_rofr, crate::CaprailError::RofrNotSupported);
        require!(
            self.rofr_window_secs <= ROFR_WINDOW_MAX_SECS,
            crate::CaprailError::InvalidPolicy
        );
        Ok(())
    }
}
