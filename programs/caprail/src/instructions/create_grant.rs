use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke_signed;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token_interface::{spl_token_2022, Mint, TokenAccount, TokenInterface};
use spl_transfer_hook_interface::onchain::add_extra_accounts_for_execute_cpi;

use crate::errors::CaprailError;
use crate::events::GrantCreated;
use crate::hook::HOOK_PROGRAM_ID;
use crate::state::{Company, Grant, TokenConfig};

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct CreateGrantArgs {
    pub total: u64,
    pub start_at: i64,
    pub cliff_at: i64,
    pub end_at: i64,
}

// The grant record and its tokens leave the treasury in one instruction, and
// the tokens go as an ordinary `transfer_checked` through the hook — so the
// recipient's admission is checked by the rule itself, as in `distribute`.
#[derive(Accounts)]
#[instruction(args: CreateGrantArgs)]
pub struct CreateGrant<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(has_one = admin @ CaprailError::Unauthorized)]
    pub company: Account<'info, Company>,
    #[account(
        has_one = company @ CaprailError::Unauthorized,
        has_one = mint @ CaprailError::TokenConfigMismatch,
    )]
    pub token_config: Box<Account<'info, TokenConfig>>,
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = company,
        associated_token::token_program = token_program,
    )]
    pub treasury: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: owner of the recipient's ATA and of the grant; admission is the hook's
    pub recipient: UncheckedAccount<'info>,
    #[account(
        init_if_needed,
        payer = admin,
        associated_token::mint = mint,
        associated_token::authority = recipient,
        associated_token::token_program = token_program,
    )]
    pub recipient_token_account: Box<InterfaceAccount<'info, TokenAccount>>,
    // `init`, not `init_if_needed`: the address holds one grant per wallet,
    // and a second call must fail rather than overwrite a schedule.
    #[account(
        init,
        payer = admin,
        space = Grant::SPACE,
        seeds = [Grant::SEED, mint.key().as_ref(), recipient.key().as_ref()],
        bump,
    )]
    pub grant: Box<Account<'info, Grant>>,
    /// CHECK: the hook's account list; Token-2022 checks it
    pub extra_account_meta_list: UncheckedAccount<'info>,
    /// CHECK: this program, under which the hook derives the state PDAs
    #[account(address = crate::ID)]
    pub state_program: UncheckedAccount<'info>,
    /// CHECK: the recipient's registry record or an empty account; the hook reads it
    pub investor_record: UncheckedAccount<'info>,
    // The hook's grant slot is the sender's — the treasury owner's — not the
    // one created above.
    /// CHECK: resolved and checked by Token-2022 from the hook's account list
    pub source_grant: UncheckedAccount<'info>,
    /// CHECK: unused until US4
    pub transfer_permit: UncheckedAccount<'info>,
    /// CHECK: fixed address
    #[account(address = HOOK_PROGRAM_ID)]
    pub hook_program: UncheckedAccount<'info>,
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn create_grant_handler(ctx: Context<CreateGrant>, args: CreateGrantArgs) -> Result<()> {
    require!(args.total > 0, CaprailError::InvalidAmount);

    let created_at = Clock::get()?.unix_timestamp;
    let bump = ctx.bumps.grant;
    let accounts = ctx.accounts;
    let grant = Grant {
        mint: accounts.mint.key(),
        wallet: accounts.recipient.key(),
        total: args.total,
        start_at: args.start_at,
        cliff_at: args.cliff_at,
        end_at: args.end_at,
        bump,
    };
    require!(
        grant.vested(created_at).is_some(),
        CaprailError::InvalidGrant
    );
    accounts.grant.set_inner(grant);

    transfer_total(accounts, args.total)?;

    emit!(GrantCreated {
        grant: accounts.grant.key(),
        company: accounts.company.key(),
        mint: accounts.mint.key(),
        wallet: accounts.recipient.key(),
        total: args.total,
        start_at: args.start_at,
        cliff_at: args.cliff_at,
        end_at: args.end_at,
        created_at,
    });
    Ok(())
}

// anchor-spl's `transfer_checked` does not pass the hook's extra accounts, so
// the instruction is assembled by hand, as in `distribute`.
fn transfer_total(accounts: &CreateGrant, amount: u64) -> Result<()> {
    let treasury = accounts.treasury.to_account_info();
    let mint = accounts.mint.to_account_info();
    let destination = accounts.recipient_token_account.to_account_info();
    let company = accounts.company.to_account_info();

    let mut instruction = spl_token_2022::instruction::transfer_checked(
        accounts.token_program.key,
        treasury.key,
        mint.key,
        destination.key,
        company.key,
        &[],
        amount,
        accounts.mint.decimals,
    )?;
    let mut account_infos = vec![
        treasury.clone(),
        mint.clone(),
        destination.clone(),
        company.clone(),
    ];
    let additional = [
        accounts.extra_account_meta_list.to_account_info(),
        accounts.state_program.to_account_info(),
        accounts.token_config.to_account_info(),
        accounts.investor_record.to_account_info(),
        accounts.source_grant.to_account_info(),
        accounts.transfer_permit.to_account_info(),
        accounts.hook_program.to_account_info(),
    ];
    add_extra_accounts_for_execute_cpi(
        &mut instruction,
        &mut account_infos,
        &HOOK_PROGRAM_ID,
        treasury,
        mint,
        destination,
        company,
        amount,
        &additional,
    )?;

    let company_id = accounts.company.company_id.to_le_bytes();
    let seeds: &[&[u8]] = &[Company::SEED, &company_id, &[accounts.company.bump]];
    invoke_signed(&instruction, &account_infos, &[seeds])?;
    Ok(())
}
