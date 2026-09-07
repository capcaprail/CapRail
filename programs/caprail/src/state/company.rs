use anchor_lang::prelude::*;

use super::DISCRIMINATOR_LEN;

// Емітент. Ролі — два різні ключі (FR-004): `admin` керує токеном, політикою і
// грантами, `compliance_officer` — статусами допуску. Сам PDA володіє
// казначейськими рахунками компанії й підписує `distribute`.
#[account]
#[derive(InitSpace)]
pub struct Company {
    // Обирає клієнт; ізоляція компаній (FR-018) — через цей seed.
    pub company_id: u64,
    pub admin: Pubkey,
    pub compliance_officer: Pubkey,
    // UTF-8, доповнено нулями. Фіксована довжина — щоб акаунт не мав `Vec`.
    pub name: [u8; Company::NAME_LEN],
    // Скільки токенів капіталу створено під цією компанією.
    pub token_count: u32,
    pub bump: u8,
}

impl Company {
    pub const SEED: &'static [u8] = b"company";
    pub const NAME_LEN: usize = 32;
    pub const SPACE: usize = DISCRIMINATOR_LEN + Self::INIT_SPACE;

    // Дві ролі — два ключі (FR-004). Нульовий ключ виключається окремо: ним
    // ніхто не підпише, і компанія лишилась би без цієї ролі назавжди.
    pub fn validate_roles(admin: &Pubkey, compliance_officer: &Pubkey) -> Result<()> {
        require!(
            admin != compliance_officer
                && *admin != Pubkey::default()
                && *compliance_officer != Pubkey::default(),
            crate::CaprailError::InvalidRoles
        );
        Ok(())
    }

    pub fn find_address(company_id: u64) -> (Pubkey, u8) {
        Pubkey::find_program_address(&[Self::SEED, &company_id.to_le_bytes()], &crate::ID)
    }

    // Ім'я як текст: без хвоста нулів. Тільки для логів і тестів — індекс
    // читає ім'я з події `CompanyCreated`, де воно вже рядок.
    pub fn name_str(&self) -> &str {
        let end = self
            .name
            .iter()
            .position(|b| *b == 0)
            .unwrap_or(Self::NAME_LEN);
        core::str::from_utf8(&self.name[..end]).unwrap_or("")
    }
}
