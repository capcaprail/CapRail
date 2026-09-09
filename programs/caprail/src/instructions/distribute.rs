use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke_signed;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token_interface::{spl_token_2022, Mint, TokenAccount, TokenInterface};
use spl_transfer_hook_interface::onchain::add_extra_accounts_for_execute_cpi;

use crate::errors::CaprailError;
use crate::hook::HOOK_PROGRAM_ID;
use crate::state::{Company, TokenConfig};

// Розподіл частки з казначейства — звичайний `transfer_checked` під підписом
// `Company` PDA, тобто через хук: допуск одержувача перевіряє те саме правило,
// що й для стороннього гаманця, і журнал отримує `TransferAllowed` звідти ж.
// Окремої події й окремої перевірки тут немає навмисне — дві копії правила
// розійшлися б мовчки.
#[derive(Accounts)]
pub struct Distribute<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    // Токеном керує адміністратор (FR-004). Канонічність PDA не перевіряється
    // наново: акаунт із нашим дискримінатором створює лише `create_company`, і
    // лише за своїми seeds — саме ними компанія й підпише переказ.
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
    // Гаманець інвестора — лише адреса: чи він допущений, вирішує хук за
    // записом реєстру нижче, а не ця інструкція.
    /// CHECK: адреса власника ATA; допуск перевіряє хук
    pub investor: UncheckedAccount<'info>,
    // Рахунок інвестора — його ATA, створений тут, якщо його ще немає (ренту
    // платить адміністратор): новий гаманець отримує частку без жодного кроку
    // зі свого боку, а індекс виводить адресу рахунку з гаманця.
    #[account(
        init_if_needed,
        payer = admin,
        associated_token::mint = mint,
        associated_token::authority = investor,
        associated_token::token_program = token_program,
    )]
    pub investor_token_account: Box<InterfaceAccount<'info, TokenAccount>>,
    // Хвіст хука. Токен-програма резолвить його зі списку мінта і відкидає
    // переказ, у якому акаунти не ті, — тут вони лише передаються далі.
    /// CHECK: список акаунтів хука; звіряє Token-2022
    pub extra_account_meta_list: UncheckedAccount<'info>,
    /// CHECK: ця ж програма — власник PDA стану, під нею хук виводить адреси
    #[account(address = crate::ID)]
    pub state_program: UncheckedAccount<'info>,
    /// CHECK: запис реєстру інвестора або порожній акаунт; читає хук
    pub investor_record: UncheckedAccount<'info>,
    /// CHECK: до US3 не використовується
    pub grant: UncheckedAccount<'info>,
    /// CHECK: до US4 не використовується
    pub transfer_permit: UncheckedAccount<'info>,
    // Програма-хук мусить бути серед акаунтів: Token-2022 робить у неї CPI.
    // Це окрема програма саме тому, що звідси в неї не можна було б повернутись
    // (див. `hook`).
    /// CHECK: адреса зафіксована
    #[account(address = HOOK_PROGRAM_ID)]
    pub hook_program: UncheckedAccount<'info>,
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn distribute_handler(ctx: Context<Distribute>, amount: u64) -> Result<()> {
    // Нульовий переказ Token-2022 пропускає, але хук записав би в журнал
    // «розподіл», якого не було.
    require!(amount > 0, CaprailError::InvalidAmount);

    let accounts = &ctx.accounts;
    let treasury = accounts.treasury.to_account_info();
    let mint = accounts.mint.to_account_info();
    let destination = accounts.investor_token_account.to_account_info();
    let company = accounts.company.to_account_info();

    // anchor-spl `transfer_checked` хвіст акаунтів не передає, тому інструкція
    // збирається вручну: базові чотири, далі інтерфейсний хелпер резолвить
    // додаткові зі списку і додає список та програму хука — так само, як це
    // робить клієнт через `addExtraAccountMetasForExecute`.
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
    // Серед додаткових — і ця програма: список хука виводить PDA стану під нею.
    let additional = [
        accounts.extra_account_meta_list.to_account_info(),
        accounts.state_program.to_account_info(),
        accounts.token_config.to_account_info(),
        accounts.investor_record.to_account_info(),
        accounts.grant.to_account_info(),
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
