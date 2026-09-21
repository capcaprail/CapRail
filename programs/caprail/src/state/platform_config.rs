use anchor_lang::prelude::*;

use super::DISCRIMINATOR_LEN;

// Налаштування платформи (FR-013) — один PDA на всю програму, без company_id
// у seeds: комісія і стейблкоїн оплати спільні для всіх емітентів. Створює
// `init_platform` один раз ключем `authority`, що живе поза серверами.
#[account]
#[derive(InitSpace)]
pub struct PlatformConfig {
    pub authority: Pubkey,
    // Mint стейблкоїна, в якому задаються ціни пропозицій і йде оплата.
    pub payment_mint: Pubkey,
    // Токен-рахунок `payment_mint`, куди `accept_offer` кладе комісію. Саме
    // рахунок, а не гаманець-власник: інструкції не треба виводити ATA і
    // тягти ще один акаунт у кадр.
    pub fee_treasury: Pubkey,
    // Частка з оплати в базисних пунктах (1 bps = 0,01 %).
    pub fee_bps: u16,
    pub bump: u8,
}

// Знаменник базисних пунктів.
pub const BPS_DENOMINATOR: u64 = 10_000;

// Стеля комісії. Понад 10 % від угоди — не тариф платформи, а помилка вводу
// (як `ROFR_WINDOW_MAX_SECS` для політики).
pub const FEE_BPS_MAX: u16 = 1_000;

impl PlatformConfig {
    pub const SEED: &'static [u8] = b"platform";
    pub const SPACE: usize = DISCRIMINATOR_LEN + Self::INIT_SPACE;

    pub fn find_address() -> (Pubkey, u8) {
        Pubkey::find_program_address(&[Self::SEED], &crate::ID)
    }

    pub fn validate_fee_bps(fee_bps: u16) -> Result<()> {
        require!(fee_bps <= FEE_BPS_MAX, crate::CaprailError::InvalidFee);
        Ok(())
    }

    // Комісія з оплати `payment` (у мінімальних одиницях `payment_mint`),
    // округлена вниз: платформа ніколи не бере більше за номінальний відсоток,
    // дрібна угода може дати нуль. Та сама формула на TS у попередньому
    // розрахунку (T041) — сторони бачать число до прийняття (FR-013).
    pub fn fee_for(&self, payment: u64) -> u64 {
        // `u64 × u16` в u128 не переповнюється; ділення повертає в межі u64.
        let fee = u128::from(payment) * u128::from(self.fee_bps) / u128::from(BPS_DENOMINATOR);
        fee as u64
    }
}
