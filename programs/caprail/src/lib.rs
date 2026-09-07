//! Ончейн-програма CapRail: одна на всіх емітентів, політика — дані в PDA.
//!
//! Правило допуску, vesting і ROFR виконує сам токен: mint компанії створюється
//! з розширенням `TransferHook`, і Token-2022 викликає інструкцію `execute`
//! на кожному `transfer_checked` — зі сторонніх гаманців і з CPI теж.
//! Хук акаунтів не створює; відсутній PDA трактується за змістом (див. `hook`).

use anchor_lang::prelude::*;

pub mod errors;
pub mod events;
pub mod hook;
pub mod instructions;
pub mod state;

pub use errors::CaprailError;
use instructions::*;

declare_id!("As8C4JwSGHd7HPvh5KD1FhhLsQphQ8veSdhipiSRWs7g");

#[program]
pub mod caprail {
    use super::*;

    // Компанія-емітент: адміністратор підписує і платить, комплаєнс-офіцер —
    // окремий ключ в аргументах.
    pub fn create_company(ctx: Context<CreateCompany>, args: CreateCompanyArgs) -> Result<()> {
        instructions::create_company_handler(ctx, args)
    }

    // Токен капіталу з прикріпленою політикою: mint із хуком і метаданими,
    // казначейство, увесь випуск одним `mint_to`, право емісії відкликане.
    pub fn create_token(ctx: Context<CreateToken>, args: CreateTokenArgs) -> Result<()> {
        instructions::create_token_handler(ctx, args)
    }
}
