//! Інструкція `execute` — саме правило. Її викликає Token-2022 на кожному
//! `transfer_checked` мінта з хуком: зі сторонніх гаманців і з CPI теж.
//!
//! **Що тут перевіряється, а що ні.** Токен-програма до виклику вже звірила
//! мінт обох рахунків, підпис власника, баланс і — головне — резолвнула
//! додаткові акаунти зі списку (`extra_account_metas`) і відкинула переказ,
//! у якому вони не збігаються. Тому хук не виводить PDA наново: він перевіряє
//! те, чого токен-програма не знає, — політику, реєстр і час.
//!
//! **Хук не створює акаунтів.** Запис реєстру, якого немає, приходить порожнім
//! системним акаунтом і читається за змістом: інвестор без запису — не допущений.
//!
//! Check 4 (ROFR, US4) goes here too, after check 3, in the order of
//! `PLAN.md`; its account (`transfer_permit`) already arrives — the mint's
//! account list does not change.
//!
//! Стан тут чужий: усі акаунти нижче створює і змінює `caprail`, ця програма
//! їх тільки читає (`Account<TokenConfig>` перевіряє власника `caprail::ID`).

use anchor_lang::prelude::*;
use anchor_spl::token_2022::spl_token_2022::extension::transfer_hook::TransferHookAccount;
use anchor_spl::token_2022::spl_token_2022::extension::{
    BaseStateWithExtensions, StateWithExtensions,
};
use anchor_spl::token_2022::spl_token_2022::state::Account as TokenAccount;
use spl_discriminator::SplDiscriminate;
use spl_transfer_hook_interface::instruction::ExecuteInstruction;

use caprail::events::TransferAllowed;
use caprail::state::{Grant, InvestorRecord, InvestorStatus, TokenConfig};
use caprail::CaprailError;

/// Дискримінатор не Anchor-івський, а з інтерфейсу хука: Token-2022 кладе в
/// дані CPI саме його, і `#[program]` диспетчить по ньому через
/// `#[instruction(discriminator = …)]` у `lib.rs`.
pub const EXECUTE_DISCRIMINATOR: &[u8] = ExecuteInstruction::SPL_DISCRIMINATOR_SLICE;

// Порядок і кількість акаунтів задає інтерфейс хука (0–4) і наш список (5–9):
// переставити тут — означає читати політику з чужого акаунта.
#[derive(Accounts)]
pub struct Execute<'info> {
    // 0. Токен-рахунок відправника. Мінт, баланс і підпис власника вже
    // перевірила токен-програма; звідси береться лише `owner` і прапорець
    // `transferring`.
    /// CHECK: розкладка Token-2022 читається в обробнику
    pub source: UncheckedAccount<'info>,
    // 1. Мінт — потрібен лише як ключ для зв'язку з `TokenConfig`.
    /// CHECK: ключ звіряється з `token_config.mint`
    pub mint: UncheckedAccount<'info>,
    // 2. Токен-рахунок одержувача: `owner` — гаманець, який має бути допущений.
    /// CHECK: розкладка Token-2022 читається в обробнику
    pub destination: UncheckedAccount<'info>,
    // 3. Власник (або делегат) рахунку відправника — підписант переказу.
    /// CHECK: підпис перевірила токен-програма
    pub owner: UncheckedAccount<'info>,
    // 4. `ExtraAccountMetaList` — за ним токен-програма резолвила хвіст.
    /// CHECK: хук його не читає
    pub extra_account_meta_list: UncheckedAccount<'info>,
    // 5. Програма `caprail` — власник стану; Token-2022 виводить під нею PDA
    // нижче, тут вона лише проїжджає.
    /// CHECK: адреса зафіксована списком акаунтів хука
    #[account(address = caprail::ID)]
    pub state_program: UncheckedAccount<'info>,
    // 6. Політика мінта. `has_one` — перевірка 1: конфіг належить саме цьому
    // мінту. Через токен-програму сюди інший і не приїде, але на прямий виклик
    // причина має бути названа.
    #[account(has_one = mint @ CaprailError::TokenConfigMismatch)]
    pub token_config: Account<'info, TokenConfig>,
    // 7. Запис реєстру одержувача. Не `Account<…>`: відсутній PDA — законний
    // стан («не допущений»), а типізований акаунт відкинув би його раніше за
    // обробник і з чужою причиною.
    /// CHECK: власник і дискримінатор перевіряються в обробнику
    pub investor_record: UncheckedAccount<'info>,
    // 8. The sender's grant — check 3. Not `Account<…>` for the same reason
    // as the record: a wallet without a grant is the usual case.
    /// CHECK: owner and discriminator are checked in the handler
    pub grant: UncheckedAccount<'info>,
    // 9. Дозвіл ROFR — перевірка 4 (US4). Поки не читається.
    /// CHECK: до US4 не використовується
    pub transfer_permit: UncheckedAccount<'info>,
}

/// Те, що хук бере з токен-рахунку: чий він і чи справді зараз іде переказ.
struct TransferSide {
    owner: Pubkey,
    amount: u64,
    transferring: bool,
}

// Прапорець `transferring` ставить лише Token-2022 і лише на час переказу;
// рахунок без розширення `TransferHookAccount` (мінт без хука) його не має —
// для нас це те саме, що «не переказ».
fn read_side(info: &AccountInfo) -> Result<TransferSide> {
    let data = info.try_borrow_data()?;
    let state = StateWithExtensions::<TokenAccount>::unpack(&data)?;
    let transferring = state
        .get_extension::<TransferHookAccount>()
        .map(|extension| bool::from(extension.transferring))
        .unwrap_or(false);
    Ok(TransferSide {
        owner: state.base.owner,
        amount: state.base.amount,
        transferring,
    })
}

// Адресу запису вже вивела й звірила токен-програма (seeds — мінт і гаманець
// одержувача), тож тут лише два стани: акаунт наш — читаємо; чужий (порожній
// системний) — запису немає.
fn read_investor_record(info: &AccountInfo) -> Result<Option<InvestorRecord>> {
    if info.owner != &caprail::ID {
        return Ok(None);
    }
    let data = info.try_borrow_data()?;
    Ok(Some(InvestorRecord::try_deserialize(&mut &data[..])?))
}

// Same two states as the record: the token program already derived the address
// from the source account's owner, so an account we own there is that grant.
fn read_grant(info: &AccountInfo) -> Result<Option<Grant>> {
    if info.owner != &caprail::ID {
        return Ok(None);
    }
    let data = info.try_borrow_data()?;
    Ok(Some(Grant::try_deserialize(&mut &data[..])?))
}

pub fn execute_handler(ctx: Context<Execute>, amount: u64) -> Result<()> {
    let source = read_side(&ctx.accounts.source)?;
    let destination = read_side(&ctx.accounts.destination)?;

    // Перевірка 1 (друга половина): хук викликано зсередини переказу, а не
    // напряму. Прямий виклик не рухає токенів, але емітив би `TransferAllowed`
    // — і журнал показав би переказ, якого не було.
    require!(
        source.transferring && destination.transferring,
        CaprailError::NotTransferring
    );

    let config = &ctx.accounts.token_config;
    let from_treasury = source.owner == config.treasury_owner;
    let to_treasury = destination.owner == config.treasury_owner;

    // Перевірка 2: допуск одержувача. Казначейство компанії — виняток (викуп
    // за ROFR, повернення частки): у нього допуску немає і не буде.
    if !to_treasury && config.policy.require_accreditation {
        let record = read_investor_record(&ctx.accounts.investor_record)?;
        let record = record.ok_or(CaprailError::NotAccredited)?;
        require!(
            record.status == InvestorStatus::Approved,
            CaprailError::NotAccredited
        );
        // Строга нерівність: допуск до кінця дня діє до кінця дня, не довше.
        let now = Clock::get()?.unix_timestamp;
        require!(record.expires_at > now, CaprailError::AccreditationExpired);
    }

    // Check 3: the unvested part of the grant stays on the account. The hook
    // runs after the debit, so `source.amount` is already the balance left;
    // tokens bought on top of the grant are outside `total` and move freely.
    if let Some(grant) = read_grant(&ctx.accounts.grant)? {
        let now = Clock::get()?.unix_timestamp;
        // `create_grant` refuses a schedule without a vesting curve; should one
        // reach here anyway, it vests nothing — the lock errs on the safe side.
        let locked = grant.total - grant.vested(now).unwrap_or(0);
        require!(source.amount >= locked, CaprailError::Unvested);
    }

    // Єдине джерело журналу успішних переказів (FR-008): і `distribute`, і
    // прямий переказ між інвесторами проходять тут, і worker бачить їх однаково.
    emit!(TransferAllowed {
        company: config.company,
        mint: config.mint,
        source: ctx.accounts.source.key(),
        destination: ctx.accounts.destination.key(),
        source_owner: source.owner,
        destination_owner: destination.owner,
        amount,
        from_treasury,
        policy_version: config.policy_version,
    });
    Ok(())
}
