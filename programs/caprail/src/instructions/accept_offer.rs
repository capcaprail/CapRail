use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke_signed;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token_interface::{
    spl_token_2022, transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked,
};
use spl_transfer_hook_interface::onchain::add_extra_accounts_for_execute_cpi;

use crate::errors::CaprailError;
use crate::events::OfferAccepted;
use crate::hook::HOOK_PROGRAM_ID;
use crate::state::{Offer, OfferStatus, PlatformConfig, TokenConfig};

// Угода на вторинному ринку (FR-012, FR-013): три перекази в одній інструкції —
// токен продавець → покупець (делегатом `Offer` PDA, через хук), оплата
// покупець → продавець за вирахуванням комісії, комісія → рахунок платформи.
// Будь-яка відмова (хук, баланс, делегування) відкочує всю транзакцію, тож
// половини угоди в мережі не буває (SC-006).
#[derive(Accounts)]
pub struct AcceptOffer<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,
    #[account(
        seeds = [PlatformConfig::SEED],
        bump = platform.bump,
        has_one = payment_mint,
        has_one = fee_treasury,
    )]
    pub platform: Box<Account<'info, PlatformConfig>>,
    // Канонічність PDA не перевіряється наново: акаунт із нашим дискримінатором
    // створює лише `create_offer`, і лише за своїми seeds — ними ж він підпише
    // переказ нижче.
    #[account(
        mut,
        has_one = seller @ CaprailError::InvalidOffer,
        has_one = mint @ CaprailError::InvalidOffer,
        constraint = offer.is_open() @ CaprailError::OfferNotOpen,
    )]
    pub offer: Box<Account<'info, Offer>>,
    // Продавець не підписує: згоду він дав делегуванням у `create_offer`.
    /// CHECK: адреса звірена з `offer.seller`
    pub seller: UncheckedAccount<'info>,
    #[account(has_one = mint @ CaprailError::TokenConfigMismatch)]
    pub token_config: Box<Account<'info, TokenConfig>>,
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = seller,
        associated_token::token_program = token_program,
    )]
    pub seller_token_account: Box<InterfaceAccount<'info, TokenAccount>>,
    // Рахунок покупця — ATA, створений тут, якщо його ще немає: перша покупка
    // не вимагає окремого кроку, а індекс виводить адресу з гаманця.
    // Угоду продавця з самим собою окремо не перевіряємо: тоді цей ATA — той
    // самий рахунок, що `seller_token_account`, і Anchor відкидає інструкцію з
    // двома однаковими `mut`-акаунтами (`ConstraintDuplicateMutableAccount`)
    // раніше за будь-який констрейнт; тест тримає це під наглядом.
    #[account(
        init_if_needed,
        payer = buyer,
        associated_token::mint = mint,
        associated_token::authority = buyer,
        associated_token::token_program = token_program,
    )]
    pub buyer_token_account: Box<InterfaceAccount<'info, TokenAccount>>,
    pub payment_mint: Box<InterfaceAccount<'info, Mint>>,
    // Платити покупець може з будь-якого свого рахунку `payment_mint`, не лише
    // з ATA.
    #[account(
        mut,
        token::mint = payment_mint,
        token::authority = buyer,
        token::token_program = payment_token_program,
    )]
    pub buyer_payment_account: Box<InterfaceAccount<'info, TokenAccount>>,
    // Продавцю — саме на ATA, створений тут коштом покупця, якщо його ще немає:
    // продавець, який ніколи не тримав стейблкоїна, інакше мав би пропозицію,
    // яку ніхто не може прийняти, і не знав би чому.
    #[account(
        init_if_needed,
        payer = buyer,
        associated_token::mint = payment_mint,
        associated_token::authority = seller,
        associated_token::token_program = payment_token_program,
    )]
    pub seller_payment_account: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut)]
    pub fee_treasury: Box<InterfaceAccount<'info, TokenAccount>>,
    // Хвіст хука — як у `distribute`: Token-2022 резолвить його зі списку мінта
    // і відкидає переказ, у якому акаунти не ті.
    /// CHECK: список акаунтів хука; звіряє Token-2022
    pub extra_account_meta_list: UncheckedAccount<'info>,
    /// CHECK: ця ж програма — власник PDA стану, під нею хук виводить адреси
    #[account(address = crate::ID)]
    pub state_program: UncheckedAccount<'info>,
    /// CHECK: запис реєстру покупця або порожній акаунт; читає хук
    pub investor_record: UncheckedAccount<'info>,
    /// CHECK: грант продавця; до US3 не використовується
    pub grant: UncheckedAccount<'info>,
    /// CHECK: дозвіл ROFR; до US4 не використовується
    pub transfer_permit: UncheckedAccount<'info>,
    /// CHECK: адреса зафіксована
    #[account(address = HOOK_PROGRAM_ID)]
    pub hook_program: UncheckedAccount<'info>,
    pub token_program: Interface<'info, TokenInterface>,
    // Окремо від `token_program`: стейблкоїн може жити на класичній програмі.
    pub payment_token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn accept_offer_handler(ctx: Context<AcceptOffer>, amount: u64) -> Result<()> {
    require!(amount > 0, CaprailError::InvalidAmount);
    let accounts = &ctx.accounts;
    let offer = &accounts.offer;
    let offer_key = offer.key();

    let now = Clock::get()?.unix_timestamp;
    // Поки вікно ROFR відкрите, купити може лише компанія (`accept_rofr`, US4).
    require!(!offer.in_rofr_window(now), CaprailError::RofrWindowOpen);
    let payment = offer
        .payment_for(amount)
        .ok_or(CaprailError::AmountExceedsRemaining)?;
    let fee = accounts.platform.fee_for(payment);
    // `fee_for` не більше 10 % від `payment` — віднімання не переповнюється.
    let proceeds = payment - fee;

    // Без цих перевірок Token-2022 відмовив би однаково, але чужим кодом
    // («owner does not match», «insufficient funds»), і покупець не зрозумів би,
    // що справа в продавці. Той самий стан індекс показує як `stale`.
    let source = &accounts.seller_token_account;
    require!(
        Option::<Pubkey>::from(source.delegate) == Some(offer_key)
            && source.delegated_amount >= amount
            && source.amount >= amount,
        CaprailError::OfferStale
    );

    transfer_shares(accounts, amount)?;

    let payment_program = accounts.payment_token_program.key();
    let decimals = accounts.payment_mint.decimals;
    transfer_checked(
        CpiContext::new(
            payment_program,
            TransferChecked {
                from: accounts.buyer_payment_account.to_account_info(),
                mint: accounts.payment_mint.to_account_info(),
                to: accounts.seller_payment_account.to_account_info(),
                authority: accounts.buyer.to_account_info(),
            },
        ),
        proceeds,
        decimals,
    )?;
    // Нульова комісія на дрібній угоді — не переказ: рахунок платформи не мусить
    // з'являтися в журналі рядком на нуль.
    if fee > 0 {
        transfer_checked(
            CpiContext::new(
                payment_program,
                TransferChecked {
                    from: accounts.buyer_payment_account.to_account_info(),
                    mint: accounts.payment_mint.to_account_info(),
                    to: accounts.fee_treasury.to_account_info(),
                    authority: accounts.buyer.to_account_info(),
                },
            ),
            fee,
            decimals,
        )?;
    }

    let buyer = accounts.buyer.key();
    let company = accounts.token_config.company;
    let payment_mint = accounts.payment_mint.key();
    let offer = &mut ctx.accounts.offer;
    offer.remaining -= amount;
    if offer.remaining == 0 {
        offer.status = OfferStatus::Filled;
    }

    emit!(OfferAccepted {
        offer: offer_key,
        company,
        mint: offer.mint,
        seller: offer.seller,
        buyer,
        offer_id: offer.offer_id,
        amount,
        price_per_unit: offer.price_per_unit,
        payment,
        fee,
        payment_mint,
        remaining: offer.remaining,
        accepted_at: now,
    });
    Ok(())
}

// Переказ частки підписує `Offer` PDA як делегат рахунку продавця. anchor-spl
// `transfer_checked` хвоста хука не передає, тож інструкція збирається вручну,
// як у `distribute`. Окрема функція — щоб `Vec` акаунтів і інструкція жили у
// своєму кадрі, а не в кадрі хендлера поруч із рештою угоди.
fn transfer_shares(accounts: &AcceptOffer, amount: u64) -> Result<()> {
    let offer = &accounts.offer;
    let source = accounts.seller_token_account.to_account_info();
    let mint = accounts.mint.to_account_info();
    let destination = accounts.buyer_token_account.to_account_info();
    let delegate = accounts.offer.to_account_info();

    let mut instruction = spl_token_2022::instruction::transfer_checked(
        accounts.token_program.key,
        source.key,
        mint.key,
        destination.key,
        delegate.key,
        &[],
        amount,
        accounts.mint.decimals,
    )?;
    let mut account_infos = vec![
        source.clone(),
        mint.clone(),
        destination.clone(),
        delegate.clone(),
    ];
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
        source,
        mint,
        destination,
        delegate,
        amount,
        &additional,
    )?;

    let offer_id = offer.offer_id.to_le_bytes();
    let seeds: &[&[u8]] = &[
        Offer::SEED,
        offer.mint.as_ref(),
        offer.seller.as_ref(),
        &offer_id,
        &[offer.bump],
    ];
    invoke_signed(&instruction, &account_infos, &[seeds])?;
    Ok(())
}
