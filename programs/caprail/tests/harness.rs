//! Тести самого стенду (T008): що Token-2022 виконується з ELF, що mint із
//! `TransferHook` доводить переказ до `caprail`, що годинник наш, і що ATA
//! стенду — та сама адреса, яку виведе програма.
//!
//! Це не тести правила — правила ще немає. Коли з'явиться `execute` (US1),
//! `hook_mint_transfer_reaches_caprail` перестане бути правдою і його замінять
//! тести хука; решта лишається.

mod common;

use anchor_lang::error::ErrorCode;
use anchor_lang::prelude::Pubkey;
use anchor_lang::solana_program::program_pack::Pack;
use anchor_spl::token_2022::spl_token_2022;
use common::*;
use solana_instruction::AccountMeta;

const SUPPLY: u64 = 1_000;

/// Один і той самий тип по обидва боки — інакше цей рядок не збереться.
#[test]
fn pubkey_types_are_one() {
    let program: solana_pubkey::Pubkey = caprail::ID;
    let anchor: Pubkey = program;
    assert_eq!(anchor.to_bytes(), caprail::ID.to_bytes());
}

#[test]
fn token_2022_moves_balance_on_a_plain_mint() {
    let mollusk = mollusk();
    let authority = Pubkey::new_unique();
    let holder = Pubkey::new_unique();
    let recipient = Pubkey::new_unique();
    let mint = Pubkey::new_unique();
    let source = ata(&holder, &mint);
    let destination = ata(&recipient, &mint);

    let result = mollusk.process_instruction(
        &transfer_checked(&mint, &source, &destination, &holder, 100, DECIMALS, &[]),
        &[
            (mint, plain_mint(&mollusk, &authority, SUPPLY, DECIMALS)),
            (
                source,
                plain_token_account(&mollusk, &mint, &holder, SUPPLY),
            ),
            (
                destination,
                plain_token_account(&mollusk, &mint, &recipient, 0),
            ),
            (holder, funded_wallet()),
        ],
    );

    assert!(is_success(&result), "{:?}", result.program_result);
    assert_eq!(token_amount(&result, &source), SUPPLY - 100);
    assert_eq!(token_amount(&result, &destination), 100);
}

/// Сенс стенду: Token-2022 бачить `TransferHook` на мінті і робить CPI в
/// `caprail`. Програма поки порожня, тож Anchor відповідає своїм кодом «немає
/// такої інструкції» — і саме він виринає як результат переказу. Це доказ, що
/// шлях «переказ → хук → наша програма» пройдено до кінця.
#[test]
fn hook_mint_transfer_reaches_caprail() {
    let mollusk = mollusk();
    let authority = Pubkey::new_unique();
    let holder = Pubkey::new_unique();
    let recipient = Pubkey::new_unique();
    let mint = Pubkey::new_unique();
    let source = ata(&holder, &mint);
    let destination = ata(&recipient, &mint);

    let mint_account = hook_mint(&mollusk, &authority, SUPPLY, DECIMALS);
    assert_eq!(hook_program_of(&mint_account), Some(caprail::ID));

    let (program_key, program_account) = caprail_program();
    let result = mollusk.process_instruction(
        &transfer_checked(
            &mint,
            &source,
            &destination,
            &holder,
            100,
            DECIMALS,
            &[AccountMeta::new_readonly(program_key, false)],
        ),
        &[
            (mint, mint_account),
            (source, hook_token_account(&mollusk, &mint, &holder, SUPPLY)),
            (
                destination,
                hook_token_account(&mollusk, &mint, &recipient, 0),
            ),
            (holder, funded_wallet()),
            (program_key, program_account),
        ],
    );

    assert_eq!(
        custom_error_code(&result),
        Some(anchor_code(ErrorCode::InstructionFallbackNotFound)),
        "{:?}",
        result.program_result
    );
    // Відкат — увесь: у відхиленого переказу баланси не рухаються.
    assert_eq!(token_amount(&result, &source), SUPPLY);
    assert_eq!(token_amount(&result, &destination), 0);
}

/// Той самий переказ без акаунта програми в інструкції має впасти ще в
/// Token-2022, а не дійти до нас: без нього CPI нікуди робити. Тест тримає
/// межу «наш код починається після цього рядка».
#[test]
fn hook_mint_transfer_without_the_program_account_fails_before_caprail() {
    let mollusk = mollusk();
    let authority = Pubkey::new_unique();
    let holder = Pubkey::new_unique();
    let recipient = Pubkey::new_unique();
    let mint = Pubkey::new_unique();
    let source = ata(&holder, &mint);
    let destination = ata(&recipient, &mint);

    let result = mollusk.process_instruction(
        &transfer_checked(&mint, &source, &destination, &holder, 100, DECIMALS, &[]),
        &[
            (mint, hook_mint(&mollusk, &authority, SUPPLY, DECIMALS)),
            (source, hook_token_account(&mollusk, &mint, &holder, SUPPLY)),
            (
                destination,
                hook_token_account(&mollusk, &mint, &recipient, 0),
            ),
            (holder, funded_wallet()),
        ],
    );

    assert!(!is_success(&result));
    assert_ne!(
        custom_error_code(&result),
        Some(anchor_code(ErrorCode::InstructionFallbackNotFound)),
        "{:?}",
        result.program_result
    );
}

#[test]
fn clock_is_ours_and_survives_advance() {
    let mut mollusk = mollusk();
    assert_eq!(now(&mollusk), GENESIS_UNIX_TS);
    assert_eq!(mollusk.sysvars.clock.slot, GENESIS_SLOT);

    advance(&mut mollusk, 86_400);
    assert_eq!(now(&mollusk), GENESIS_UNIX_TS + 86_400);
    assert_eq!(mollusk.sysvars.clock.slot, GENESIS_SLOT + 86_400 * 5 / 2);

    // Годинник, який бачить програма, — це акаунт sysvar, а не поле стенду.
    // Розкладка `Clock` — п'ять полів по 8 байтів, `unix_timestamp` п'яте.
    let (_, clock_account) = mollusk.sysvars.keyed_account_for_clock_sysvar();
    let unix_timestamp = i64::from_le_bytes(clock_account.data[32..40].try_into().expect("i64"));
    assert_eq!(unix_timestamp, GENESIS_UNIX_TS + 86_400);
}

/// Адреса ATA стенду збігається з виводом за сідами `[owner, Token-2022, mint]`
/// — тією ж формулою, якою `create_token` знайде казначейський ATA компанії.
#[test]
fn ata_matches_the_program_derivation() {
    let owner = Pubkey::new_unique();
    let mint = Pubkey::new_unique();
    let (derived, _) = Pubkey::find_program_address(
        &[owner.as_ref(), spl_token_2022::ID.as_ref(), mint.as_ref()],
        &anchor_spl::associated_token::ID,
    );
    assert_eq!(ata(&owner, &mint), derived);
}

#[test]
fn account_layouts_are_the_interface_lengths() {
    let mollusk = mollusk();
    let key = Pubkey::new_unique();
    assert_eq!(
        plain_mint(&mollusk, &key, 0, DECIMALS).data.len(),
        spl_token_2022::state::Mint::LEN
    );
    assert_eq!(
        plain_token_account(&mollusk, &key, &key, 0).data.len(),
        spl_token_2022::state::Account::LEN
    );
    // З розширеннями довжина більша за базову — інакше Token-2022 прочитав би їх як
    // акаунт без розширень і хук не викликав би.
    assert!(hook_mint(&mollusk, &key, 0, DECIMALS).data.len() > spl_token_2022::state::Mint::LEN);
    assert!(
        hook_token_account(&mollusk, &key, &key, 0).data.len()
            > spl_token_2022::state::Account::LEN
    );
}
