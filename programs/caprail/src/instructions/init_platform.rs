use anchor_lang::prelude::*;
use anchor_spl::token_interface::spl_token_2022::extension::{
    BaseStateWithExtensions, ExtensionType, StateWithExtensions,
};
use anchor_spl::token_interface::spl_token_2022::state::Mint as MintState;
use anchor_spl::token_interface::{Mint, TokenAccount};

use crate::errors::CaprailError;
use crate::events::PlatformInitialized;
use crate::state::PlatformConfig;

// Налаштування платформи (FR-013) — один раз на розгортання програми. Ключ
// `authority` живе офлайн: це єдиний ключ продукту поза гаманцями, і панель цю
// інструкцію не будує — її будує `tools/demo init-platform`.
#[derive(Accounts)]
pub struct InitPlatform<'info> {
    // Підписує і платить той самий офлайн-ключ; окремого платника немає, бо
    // немає й сервера, який міг би ним бути.
    #[account(mut)]
    pub authority: Signer<'info>,
    // `init`, а не `init_if_needed`: повторний виклик має впасти, а не
    // переписати комісію під уже виставленими пропозиціями.
    #[account(
        init,
        payer = authority,
        space = PlatformConfig::SPACE,
        seeds = [PlatformConfig::SEED],
        bump,
    )]
    pub platform: Account<'info, PlatformConfig>,
    // Стейблкоїн оплати. Інтерфейс, а не Token-2022: справжні стейблкоїни
    // здебільшого на класичній токен-програмі, а демонстраційний — на Token-2022;
    // `accept_offer` платить тією програмою, якій належить цей мінт.
    pub payment_mint: Box<InterfaceAccount<'info, Mint>>,
    // Рахунок комісії — саме токен-рахунок того ж мінта, а не гаманець-власник
    // (T034): `accept_offer` не виводить ATA і не тягне зайвий акаунт у кадр.
    #[account(token::mint = payment_mint)]
    pub fee_treasury: Box<InterfaceAccount<'info, TokenAccount>>,
    pub system_program: Program<'info, System>,
}

pub fn init_platform_handler(ctx: Context<InitPlatform>, fee_bps: u16) -> Result<()> {
    PlatformConfig::validate_fee_bps(fee_bps)?;
    require_exact_payment_mint(&ctx.accounts.payment_mint.to_account_info())?;

    let platform = &mut ctx.accounts.platform;
    platform.authority = ctx.accounts.authority.key();
    platform.payment_mint = ctx.accounts.payment_mint.key();
    platform.fee_treasury = ctx.accounts.fee_treasury.key();
    platform.fee_bps = fee_bps;
    platform.bump = ctx.bumps.platform;

    emit!(PlatformInitialized {
        platform: platform.key(),
        authority: platform.authority,
        payment_mint: platform.payment_mint,
        fee_treasury: platform.fee_treasury,
        fee_bps,
        initialized_at: Clock::get()?.unix_timestamp,
    });
    Ok(())
}

/// Мінт оплати мусить переказувати рівно те число, яке в інструкції.
///
/// `TransferHook` — оплата потребувала б акаунтів чужого правила, яких ні
/// `accept_offer`, ні гаманець не знають звідки взяти. `TransferFeeConfig` —
/// продавець і казна платформи отримали б менше за `amount × price`, тобто не
/// те число, яке сторони бачили до прийняття (FR-013).
///
/// Перевірка тут, а не в `accept_offer`: ця інструкція йде один раз і через
/// `init`, тож хибний мінт — це не відмова в одній угоді, а платформа, якої не
/// перезаписати. Решту розширень не перелічуємо: вони або не міняють суму
/// переказу, або зупиняють його тимчасово.
fn require_exact_payment_mint(info: &AccountInfo<'_>) -> Result<()> {
    let data = info.try_borrow_data()?;
    // Розкладка Token-2022 читає і класичний мінт: 82 байти без розширень.
    let state = StateWithExtensions::<MintState>::unpack(&data)
        .map_err(|_| error!(CaprailError::InvalidPaymentMint))?;
    let extensions = state
        .get_extension_types()
        .map_err(|_| error!(CaprailError::InvalidPaymentMint))?;
    require!(
        !extensions.contains(&ExtensionType::TransferHook)
            && !extensions.contains(&ExtensionType::TransferFeeConfig),
        CaprailError::InvalidPaymentMint
    );
    Ok(())
}
