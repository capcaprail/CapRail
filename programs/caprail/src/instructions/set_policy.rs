use anchor_lang::prelude::*;

use crate::errors::CaprailError;
use crate::events::PolicySet;
use crate::state::{Company, TokenConfig, TransferPolicy};

#[derive(Accounts)]
pub struct SetPolicy<'info> {
    pub admin: Signer<'info>,
    // Політику міняє адміністратор; комплаєнс-офіцер не може (FR-004).
    #[account(has_one = admin @ CaprailError::Unauthorized)]
    pub company: Account<'info, Company>,
    // `has_one = company` тримає ізоляцію компаній (FR-018): чужий `TokenConfig`
    // під власним адміном не пройде.
    #[account(mut, has_one = company @ CaprailError::Unauthorized)]
    pub token_config: Account<'info, TokenConfig>,
}

pub fn set_policy_handler(ctx: Context<SetPolicy>, policy: TransferPolicy) -> Result<()> {
    // Та сама перевірка, що й у `create_token`: інакше політика, неможлива при
    // випуску, стала б можливою через зміну.
    policy.validate()?;

    let config = &mut ctx.accounts.token_config;
    config.policy = policy;
    // Версія росте на кожну зміну — по ній індекс веде історію, а `TransferAllowed`
    // майбутнього хука можна зіставити з політикою, що діяла на той момент.
    config.policy_version = config
        .policy_version
        .checked_add(1)
        .ok_or(CaprailError::InvalidPolicy)?;

    // Нова політика діє з наступного переказу і без дій держателів (FR-009):
    // хук читає `TokenConfig` на кожному `transfer_checked`, перевипуск не потрібен.
    emit!(PolicySet {
        company: ctx.accounts.company.key(),
        mint: config.mint,
        policy,
        policy_version: config.policy_version,
        set_at: Clock::get()?.unix_timestamp,
    });
    Ok(())
}
