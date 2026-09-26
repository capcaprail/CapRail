use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    approve_checked, ApproveChecked, Mint, TokenAccount, TokenInterface,
};

use crate::errors::CaprailError;
use crate::events::OfferCreated;
use crate::state::{Offer, OfferStatus, PlatformConfig, TokenConfig};

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct CreateOfferArgs {
    // Обирає продавець; зайнятий id дає відмову `init`, а не перезапис.
    pub offer_id: u64,
    // У мінімальних одиницях токена компанії.
    pub amount: u64,
    // За одну мінімальну одиницю токена, у мінімальних одиницях `payment_mint`.
    pub price_per_unit: u64,
}

// Пропозиція продажу без ескроу (FR-011): токени лишаються в продавця, а
// `Offer` PDA стає делегатом його рахунку на `amount`. Ескроу під PDA хук
// відхилив би як недопущеного одержувача.
#[derive(Accounts)]
#[instruction(args: CreateOfferArgs)]
pub struct CreateOffer<'info> {
    #[account(mut)]
    pub seller: Signer<'info>,
    // Без платформи ціні немає в чому бути: одиниці — це `payment_mint`.
    #[account(seeds = [PlatformConfig::SEED], bump = platform.bump)]
    pub platform: Box<Account<'info, PlatformConfig>>,
    // Мінт мусить бути токеном CapRail: пропозиція на чужий мінт засмічувала б
    // ринок угодами, яких `accept_offer` не виконає.
    #[account(has_one = mint @ CaprailError::TokenConfigMismatch)]
    pub token_config: Box<Account<'info, TokenConfig>>,
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    // Саме ATA: `Offer` не зберігає рахунок продавця, і `accept_offer` виведе
    // його з (seller, mint) тією ж формулою.
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = seller,
        associated_token::token_program = token_program,
    )]
    pub seller_token_account: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        init,
        payer = seller,
        space = Offer::SPACE,
        seeds = [
            Offer::SEED,
            mint.key().as_ref(),
            seller.key().as_ref(),
            &args.offer_id.to_le_bytes(),
        ],
        bump,
    )]
    pub offer: Box<Account<'info, Offer>>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

pub fn create_offer_handler(ctx: Context<CreateOffer>, args: CreateOfferArgs) -> Result<()> {
    Offer::validate_terms(args.amount, args.price_per_unit)?;

    let source = &ctx.accounts.seller_token_account;
    // Баланс пізніше може змінитись (тоді індекс покаже `stale`), але
    // пропозиція понад наявне — помилка вводу вже в момент публікації.
    require!(
        args.amount <= source.amount,
        CaprailError::OfferExceedsBalance
    );
    // У токен-рахунку один делегат: `approve` мовчки замінив би делегування
    // попередньої пропозиції (чи чужого протоколу), і та стала б невиконуваною
    // без жодного сліду в її стані. Виконана пропозиція делегування не тримає —
    // Token-2022 скидає делегата, коли `delegated_amount` доходить до нуля.
    require!(source.delegated_amount == 0, CaprailError::DelegationInUse);

    approve_checked(
        CpiContext::new(
            ctx.accounts.token_program.key(),
            ApproveChecked {
                to: source.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                delegate: ctx.accounts.offer.to_account_info(),
                authority: ctx.accounts.seller.to_account_info(),
            },
        ),
        args.amount,
        ctx.accounts.mint.decimals,
    )?;

    let now = Clock::get()?.unix_timestamp;
    let offer = &mut ctx.accounts.offer;
    offer.mint = ctx.accounts.mint.key();
    offer.seller = ctx.accounts.seller.key();
    offer.offer_id = args.offer_id;
    offer.amount = args.amount;
    offer.remaining = args.amount;
    offer.price_per_unit = args.price_per_unit;
    // Вікно ROFR відкриває T054 разом із `set_policy`, що приймає
    // `require_rofr`; до того політика з ROFR неможлива.
    offer.rofr_until = 0;
    offer.status = OfferStatus::Open;
    offer.created_at = now;
    offer.bump = ctx.bumps.offer;

    emit!(OfferCreated {
        offer: offer.key(),
        company: ctx.accounts.token_config.company,
        mint: offer.mint,
        seller: offer.seller,
        offer_id: args.offer_id,
        amount: args.amount,
        price_per_unit: args.price_per_unit,
        payment_mint: ctx.accounts.platform.payment_mint,
        rofr_until: offer.rofr_until,
        created_at: now,
    });
    Ok(())
}
