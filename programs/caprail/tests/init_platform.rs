//! `init_platform` (T035): один PDA на всю програму — комісія, стейблкоїн
//! оплати і рахунок комісії. Інструкція йде раз і через `init`, тож тут
//! перевіряється не лише щасливий шлях, а й кожен спосіб зробити платформу,
//! якою неможливо торгувати: завелика комісія, рахунок комісії іншого мінта,
//! мінт, що переказує не те число, і повторна ініціалізація.

mod common;

use anchor_lang::error::ErrorCode;
use anchor_lang::prelude::Pubkey;
use anchor_lang::{InstructionData, ToAccountMetas};
use caprail::events::PlatformInitialized;
use caprail::state::{PlatformConfig, FEE_BPS_MAX};
use caprail::CaprailError;
use common::*;
use mollusk_svm::result::InstructionResult;
use mollusk_svm::Mollusk;
use solana_account::Account;
use solana_instruction::Instruction;

/// Демонстраційний стейблкоїн — 6 знаків, як USDC.
const USD_DECIMALS: u8 = 6;
const USD_SUPPLY: u64 = 1_000_000_000_000;
const FEE_BPS: u16 = 100;

struct Stand {
    mollusk: Mollusk,
    authority: Pubkey,
    platform: Pubkey,
    payment_mint: Pubkey,
    fee_treasury: Pubkey,
    accounts: Vec<(Pubkey, Account)>,
}

/// Стенд зі справжнім мінтом оплати: власник — випадковий ключ (емітент
/// стейблкоїна), рахунок комісії — його ATA під ключем платформи.
fn stand() -> Stand {
    let mollusk = mollusk();
    let authority = Pubkey::new_unique();
    let issuer = Pubkey::new_unique();
    let payment_mint = Pubkey::new_unique();
    let fee_treasury = ata(&authority, &payment_mint);
    let (platform, _) = PlatformConfig::find_address();
    let accounts = vec![
        (authority, funded_wallet()),
        empty(platform),
        (
            payment_mint,
            plain_mint(&mollusk, &issuer, USD_SUPPLY, USD_DECIMALS),
        ),
        (
            fee_treasury,
            plain_token_account(&mollusk, &payment_mint, &authority, 0),
        ),
        system_program(),
    ];
    Stand {
        mollusk,
        authority,
        platform,
        payment_mint,
        fee_treasury,
        accounts,
    }
}

fn instruction(
    authority: &Pubkey,
    platform: &Pubkey,
    payment_mint: &Pubkey,
    fee_treasury: &Pubkey,
    fee_bps: u16,
) -> Instruction {
    Instruction {
        program_id: caprail::ID,
        accounts: caprail::accounts::InitPlatform {
            authority: *authority,
            platform: *platform,
            payment_mint: *payment_mint,
            fee_treasury: *fee_treasury,
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
        data: caprail::instruction::InitPlatform { fee_bps }.data(),
    }
}

impl Stand {
    fn instruction(&self, fee_bps: u16) -> Instruction {
        instruction(
            &self.authority,
            &self.platform,
            &self.payment_mint,
            &self.fee_treasury,
            fee_bps,
        )
    }

    fn init(&self, fee_bps: u16) -> InstructionResult {
        self.mollusk
            .process_instruction(&self.instruction(fee_bps), &self.accounts)
    }
}

#[test]
fn initializes_the_platform_and_emits_the_event() {
    let stand = stand();
    let result = stand.init(FEE_BPS);
    assert!(is_success(&result), "{:?}", result.program_result);

    let account = account_of(&result, &stand.platform);
    assert_eq!(account.owner, caprail::ID);
    assert_eq!(account.data.len(), PlatformConfig::SPACE);

    let config: PlatformConfig = read(&result, &stand.platform);
    assert_eq!(config.authority, stand.authority);
    assert_eq!(config.payment_mint, stand.payment_mint);
    assert_eq!(config.fee_treasury, stand.fee_treasury);
    assert_eq!(config.fee_bps, FEE_BPS);
    assert_eq!(config.bump, PlatformConfig::find_address().1);
    // Та сама комісія, яку порахує TS-дубль і покаже форма прийняття (FR-013).
    assert_eq!(config.fee_for(1_000_000), 10_000);

    let emitted = events::<PlatformInitialized>(&take_logs(&stand.mollusk));
    assert_eq!(emitted.len(), 1);
    let event = &emitted[0];
    assert_eq!(event.platform, stand.platform);
    assert_eq!(event.authority, stand.authority);
    assert_eq!(event.payment_mint, stand.payment_mint);
    assert_eq!(event.fee_treasury, stand.fee_treasury);
    assert_eq!(event.fee_bps, FEE_BPS);
    assert_eq!(event.initialized_at, now(&stand.mollusk));
}

/// Комісія без комісії — теж платформа: `fee_bps = 0` валідне, а стеля
/// включна. Понад стелю — помилка вводу, і акаунта не лишається.
#[test]
fn accepts_zero_and_the_cap_but_refuses_more() {
    for fee_bps in [0, FEE_BPS_MAX] {
        let stand = stand();
        let result = stand.init(fee_bps);
        assert!(
            is_success(&result),
            "{fee_bps}: {:?}",
            result.program_result
        );
        assert_eq!(
            read::<PlatformConfig>(&result, &stand.platform).fee_bps,
            fee_bps
        );
    }

    let stand = stand();
    let result = stand.init(FEE_BPS_MAX + 1);
    assert_eq!(
        custom_error_code(&result),
        Some(expected(CaprailError::InvalidFee)),
        "{:?}",
        result.program_result
    );
    assert!(account_of(&result, &stand.platform).data.is_empty());
}

/// Рахунок комісії іншого мінта — комісія падала б у нікуди, а `accept_offer`
/// відмовляв би на кожній угоді. Ловить Anchor, до хендлера.
#[test]
fn rejects_a_fee_treasury_of_another_mint() {
    let mut stand = stand();
    let other_mint = Pubkey::new_unique();
    let issuer = Pubkey::new_unique();
    stand.accounts.push((
        other_mint,
        plain_mint(&stand.mollusk, &issuer, USD_SUPPLY, USD_DECIMALS),
    ));
    let foreign = ata(&stand.authority, &other_mint);
    stand.accounts.push((
        foreign,
        plain_token_account(&stand.mollusk, &other_mint, &stand.authority, 0),
    ));

    let result = stand.mollusk.process_instruction(
        &instruction(
            &stand.authority,
            &stand.platform,
            &stand.payment_mint,
            &foreign,
            FEE_BPS,
        ),
        &stand.accounts,
    );
    assert_eq!(
        custom_error_code(&result),
        Some(anchor_code(ErrorCode::ConstraintTokenMint)),
        "{:?}",
        result.program_result
    );
}

/// Мінт оплати з власним хуком: `accept_offer` не знає, звідки взяти акаунти
/// чужого правила, тож платформа була б мертвою з першого дня. Відмова —
/// тут, а не в кожній угоді.
#[test]
fn rejects_a_payment_mint_that_does_not_transfer_the_exact_amount() {
    let mut stand = stand();
    let issuer = Pubkey::new_unique();
    // Та сама адреса мінта, але з розширенням `TransferHook`.
    let hooked = hook_mint(&stand.mollusk, &issuer, USD_SUPPLY, USD_DECIMALS);
    for entry in &mut stand.accounts {
        if entry.0 == stand.payment_mint {
            entry.1 = hooked.clone();
        }
    }

    let result = stand.init(FEE_BPS);
    assert_eq!(
        custom_error_code(&result),
        Some(expected(CaprailError::InvalidPaymentMint)),
        "{:?}",
        result.program_result
    );
    assert!(account_of(&result, &stand.platform).data.is_empty());
}

#[test]
fn requires_the_authority_signature() {
    let stand = stand();
    let mut instruction = stand.instruction(FEE_BPS);
    instruction.accounts[0].is_signer = false;

    let result = stand
        .mollusk
        .process_instruction(&instruction, &stand.accounts);
    assert_eq!(
        custom_error_code(&result),
        Some(anchor_code(ErrorCode::AccountNotSigner)),
        "{:?}",
        result.program_result
    );
}

/// PDA платформи — без company_id і без будь-якого іншого сіда: підсунути
/// «свою платформу» за іншою адресою неможливо.
#[test]
fn rejects_a_pda_derived_from_another_seed() {
    let stand = stand();
    let (other, _) = Pubkey::find_program_address(&[PlatformConfig::SEED, b"x"], &caprail::ID);
    let mut accounts = stand.accounts.clone();
    accounts.push(empty(other));

    let result = stand.mollusk.process_instruction(
        &instruction(
            &stand.authority,
            &other,
            &stand.payment_mint,
            &stand.fee_treasury,
            FEE_BPS,
        ),
        &accounts,
    );
    assert_eq!(
        custom_error_code(&result),
        Some(anchor_code(ErrorCode::ConstraintSeeds)),
        "{:?}",
        result.program_result
    );
}

/// Повторна ініціалізація — відмова `init`, а не нова комісія під уже
/// виставленими пропозиціями.
#[test]
fn refuses_a_second_initialization() {
    let stand = stand();
    let intruder = Pubkey::new_unique();
    let mut accounts = stand.accounts.clone();
    accounts.push((intruder, funded_wallet()));

    let result = stand.mollusk.process_instruction_chain(
        &[
            stand.instruction(FEE_BPS),
            instruction(
                &intruder,
                &stand.platform,
                &stand.payment_mint,
                &stand.fee_treasury,
                FEE_BPS_MAX,
            ),
        ],
        &accounts,
    );

    assert!(!is_success(&result), "друга ініціалізація мала впасти");
    let config: PlatformConfig = read(&result, &stand.platform);
    assert_eq!(config.authority, stand.authority);
    assert_eq!(config.fee_bps, FEE_BPS);
}
