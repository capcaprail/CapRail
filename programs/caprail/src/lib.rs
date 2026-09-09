//! Ончейн-програма CapRail: одна на всіх емітентів, політика — дані в PDA.
//!
//! Правило допуску, vesting і ROFR виконує сам токен: mint компанії створюється
//! з розширенням `TransferHook`, і Token-2022 викликає `execute` програми-хука
//! `caprail-hook` на кожному `transfer_checked` — зі сторонніх гаманців і з CPI
//! теж. Хук — окрема програма, бо ця не могла б переказувати власний хукнутий
//! токен (реентерабельність); він лише читає стан звідси (див. `hook`).

use anchor_lang::prelude::*;

pub mod errors;
pub mod events;
pub mod hook;
pub mod instructions;
pub mod state;

pub use errors::CaprailError;
use instructions::*;
use state::TransferPolicy;

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

    // Нова політика токена: діє з наступного переказу, без перевипуску.
    pub fn set_policy(ctx: Context<SetPolicy>, policy: TransferPolicy) -> Result<()> {
        instructions::set_policy_handler(ctx, policy)
    }

    // Статус допуску інвестора: створює запис реєстру або оновлює наявний.
    pub fn set_investor_status(
        ctx: Context<SetInvestorStatus>,
        args: SetInvestorStatusArgs,
    ) -> Result<()> {
        instructions::set_investor_status_handler(ctx, args)
    }

    // Ролі компанії, включно з передачею adminship.
    pub fn set_roles(
        ctx: Context<SetRoles>,
        admin: Pubkey,
        compliance_officer: Pubkey,
    ) -> Result<()> {
        instructions::set_roles_handler(ctx, admin, compliance_officer)
    }

    // Розподіл частки з казначейства інвестору — через хук, як і будь-який
    // інший переказ; журнал бере `TransferAllowed` звідти.
    pub fn distribute(ctx: Context<Distribute>, amount: u64) -> Result<()> {
        instructions::distribute_handler(ctx, amount)
    }
}
