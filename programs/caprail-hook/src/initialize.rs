use anchor_lang::prelude::*;
use anchor_lang::solana_program::program_option::COption;
use anchor_spl::token_interface::Mint;
use caprail::hook::{extra_account_metas, EXTRA_ACCOUNT_COUNT, EXTRA_ACCOUNT_METAS_SEED};
use caprail::CaprailError;
use spl_tlv_account_resolution::state::ExtraAccountMetaList;
use spl_transfer_hook_interface::instruction::ExecuteInstruction;

// Порядок акаунтів — контракт із `caprail::hook::initialize_list_instruction`;
// тест `initialize_list_instruction_matches_the_accounts` тримає їх рівними.
#[derive(Accounts)]
pub struct InitializeExtraAccountMetaList<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub mint: InterfaceAccount<'info, Mint>,
    // Хто має право оголосити список для мінта — той, хто володіє емісією.
    // У CapRail це `Company` PDA всередині `create_token`, до відкликання права.
    pub authority: Signer<'info>,
    // PDA цієї програми: саме тут його шукає Token-2022
    // (`get_extra_account_metas_address(mint, hook_program)`).
    /// CHECK: акаунт стандарту інтерфейсу хука, не Anchor-тип
    #[account(
        init,
        payer = payer,
        space = ExtraAccountMetaList::size_of(EXTRA_ACCOUNT_COUNT)?,
        seeds = [EXTRA_ACCOUNT_METAS_SEED, mint.key().as_ref()],
        bump,
    )]
    pub extra_account_meta_list: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

pub fn initialize_extra_account_meta_list_handler(
    ctx: Context<InitializeExtraAccountMetaList>,
) -> Result<()> {
    require!(
        ctx.accounts.mint.mint_authority == COption::Some(ctx.accounts.authority.key()),
        CaprailError::Unauthorized
    );
    // Список пишеться один раз і на весь час життя токена
    // (див. `caprail::hook::extra_account_metas`).
    ExtraAccountMetaList::init::<ExecuteInstruction>(
        &mut ctx.accounts.extra_account_meta_list.try_borrow_mut_data()?,
        &extra_account_metas()?,
    )?;
    Ok(())
}
