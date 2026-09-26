use anchor_lang::prelude::*;
use anchor_spl::token_interface::{revoke, Mint, Revoke, TokenAccount, TokenInterface};

use crate::errors::CaprailError;
use crate::events::OfferCancelled;
use crate::state::{Offer, OfferStatus};

// Скасування пропозиції продавцем у будь-який момент до повного виконання
// (FR-011). Акаунт не закривається: статус `Cancelled` лишається в ньому, щоб
// той самий `offer_id` не дав знову ту саму адресу — індекс ключує пропозиції
// за нею, і друга пропозиція злилась би з історією першої.
#[derive(Accounts)]
pub struct CancelOffer<'info> {
    pub seller: Signer<'info>,
    // Канонічність PDA не перевіряється наново: акаунт із нашим дискримінатором
    // створює лише `create_offer`, і лише за своїми seeds.
    #[account(
        mut,
        has_one = seller @ CaprailError::Unauthorized,
        has_one = mint @ CaprailError::InvalidOffer,
        constraint = offer.is_open() @ CaprailError::OfferNotOpen,
    )]
    pub offer: Box<Account<'info, Offer>>,
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = seller,
        associated_token::token_program = token_program,
    )]
    pub seller_token_account: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Interface<'info, TokenInterface>,
}

pub fn cancel_offer_handler(ctx: Context<CancelOffer>) -> Result<()> {
    let offer_key = ctx.accounts.offer.key();
    let source = &ctx.accounts.seller_token_account;
    // Знімаємо лише своє делегування: якщо продавець уже віддав рахунок
    // іншому делегату, `revoke` стер би чуже.
    let delegated_to_offer = Option::<Pubkey>::from(source.delegate) == Some(offer_key);
    if delegated_to_offer {
        revoke(CpiContext::new(
            ctx.accounts.token_program.key(),
            Revoke {
                source: source.to_account_info(),
                authority: ctx.accounts.seller.to_account_info(),
            },
        ))?;
    }

    let offer = &mut ctx.accounts.offer;
    offer.status = OfferStatus::Cancelled;

    emit!(OfferCancelled {
        offer: offer_key,
        mint: offer.mint,
        seller: offer.seller,
        offer_id: offer.offer_id,
        remaining: offer.remaining,
        delegation_revoked: delegated_to_offer,
        cancelled_at: Clock::get()?.unix_timestamp,
    });
    Ok(())
}
