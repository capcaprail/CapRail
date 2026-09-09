//! Програма-хук CapRail: правило, яке Token-2022 виконує на кожному
//! `transfer_checked` мінта компанії.
//!
//! Окрема від `caprail` не з естетики: Solana забороняє непряму
//! реентерабельність, і програма, що є хуком мінта, не може сама переказувати
//! цей мінт через CPI (`caprail → Token-2022 → caprail` рантайм відкидає). Тому
//! стан змінює `caprail`, а ця програма його лише **читає**: `TokenConfig`,
//! `InvestorRecord`, далі `Grant` і `TransferPermit` — усі під власником
//! `caprail`. Тут дві інструкції: список акаунтів хука (пишеться раз на токен,
//! за CPI з `create_token`) і саме правило.

use anchor_lang::prelude::*;

pub mod execute;
pub mod initialize;

pub use execute::*;
pub use initialize::*;

declare_id!("6EMZVfUkf2wrtwfnESLghWfdWyzDu71uJTJ7dCKG3YEi");

#[program]
pub mod caprail_hook {
    use super::*;

    // Список додаткових акаунтів мінта; підписує mint authority (`Company`
    // PDA з `create_token`).
    pub fn initialize_extra_account_meta_list(
        ctx: Context<InitializeExtraAccountMetaList>,
    ) -> Result<()> {
        initialize::initialize_extra_account_meta_list_handler(ctx)
    }

    // Хук переказу. Викликає Token-2022 з кожного `transfer_checked` мінта з
    // хуком; дискримінатор — інтерфейсу хука, не Anchor.
    #[instruction(discriminator = EXECUTE_DISCRIMINATOR)]
    pub fn execute(ctx: Context<Execute>, amount: u64) -> Result<()> {
        execute::execute_handler(ctx, amount)
    }
}
