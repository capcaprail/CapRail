//! `create_token` (T017): mint із хуком і метаданими, казначейство під
//! `Company` PDA, увесь випуск одним `mint_to`, відкликане право емісії,
//! `TokenConfig` і подія для індексу.
//!
//! Тести читають сам мінт після інструкції — саме його бачитиме гаманець і
//! токен-програма, тож «розширення прикріплено» тут не віра, а прочитаний байт.

mod common;

use anchor_lang::error::ErrorCode;
use anchor_lang::prelude::Pubkey;
use anchor_lang::{InstructionData, ToAccountMetas};
use anchor_spl::token_2022::spl_token_2022;
use caprail::events::TokenCreated;
use caprail::hook::{EXTRA_ACCOUNT_COUNT, HOOK_PROGRAM_ID};
use caprail::instructions::{CreateTokenArgs, DECIMALS_MAX, TOKEN_SYMBOL_MAX, TOKEN_URI_MAX};
use caprail::state::{Company, TokenConfig, TransferPolicy, ROFR_WINDOW_MAX_SECS};
use caprail::CaprailError;
use common::*;
use mollusk_svm::result::InstructionResult;
use mollusk_svm::Mollusk;
use solana_account::Account;
use solana_instruction::Instruction;
use spl_tlv_account_resolution::state::ExtraAccountMetaList;
use spl_transfer_hook_interface::get_extra_account_metas_address;

const COMPANY_ID: u64 = 7;
const SUPPLY: u64 = 1_000_000;
const DECIMALS: u8 = 6;

fn policy() -> TransferPolicy {
    TransferPolicy {
        require_accreditation: true,
        require_rofr: false,
        rofr_window_secs: 0,
    }
}

fn args() -> CreateTokenArgs {
    CreateTokenArgs {
        name: "Acme Series A".to_string(),
        symbol: "ACME".to_string(),
        uri: "https://example.com/acme.json".to_string(),
        decimals: DECIMALS,
        total_supply: SUPPLY,
        policy: policy(),
    }
}

fn company_state(admin: Pubkey, token_count: u32) -> Company {
    let (_, bump) = Company::find_address(COMPANY_ID);
    let mut name = [0u8; Company::NAME_LEN];
    name[..4].copy_from_slice(b"Acme");
    Company {
        company_id: COMPANY_ID,
        admin,
        compliance_officer: Pubkey::new_unique(),
        name,
        token_count,
        bump,
    }
}

struct Setup {
    admin: Pubkey,
    company: Pubkey,
    mint: Pubkey,
    token_config: Pubkey,
    treasury: Pubkey,
    extra_metas: Pubkey,
    accounts: Vec<(Pubkey, Account)>,
}

fn setup(mollusk: &Mollusk, token_count: u32) -> Setup {
    let admin = Pubkey::new_unique();
    let (company, _) = Company::find_address(COMPANY_ID);
    let (mint, _) = TokenConfig::find_mint_address(&company, token_count);
    let (token_config, _) = TokenConfig::find_address(&mint);
    let treasury = ata(&company, &mint);
    let extra_metas = get_extra_account_metas_address(&mint, &HOOK_PROGRAM_ID);

    Setup {
        admin,
        company,
        mint,
        token_config,
        treasury,
        extra_metas,
        accounts: vec![
            (admin, funded_wallet()),
            (
                company,
                anchor_account(mollusk, &company_state(admin, token_count)),
            ),
            empty(mint),
            empty(token_config),
            empty(treasury),
            empty(extra_metas),
            hook_program(),
            token_program(),
            ata_program(),
            system_program(),
        ],
    }
}

fn instruction(setup: &Setup, args: CreateTokenArgs) -> Instruction {
    Instruction {
        program_id: caprail::ID,
        accounts: caprail::accounts::CreateToken {
            admin: setup.admin,
            company: setup.company,
            mint: setup.mint,
            token_config: setup.token_config,
            treasury: setup.treasury,
            extra_account_meta_list: setup.extra_metas,
            hook_program: HOOK_PROGRAM_ID,
            token_program: spl_token_2022::ID,
            associated_token_program: anchor_spl::associated_token::ID,
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
        data: caprail::instruction::CreateToken { args }.data(),
    }
}

fn create(mollusk: &Mollusk, setup: &Setup, args: CreateTokenArgs) -> InstructionResult {
    mollusk.process_instruction(&instruction(setup, args), &setup.accounts)
}

#[test]
fn mints_the_whole_supply_to_the_treasury_and_attaches_the_policy() {
    let mollusk = mollusk();
    let setup = setup(&mollusk, 0);

    let result = create(&mollusk, &setup, args());
    assert!(is_success(&result), "{:?}", result.program_result);

    // Найважча інструкція `caprail` (мінт із трьома розширеннями, метадані,
    // казначейство, CPI в хук) — у бюджеті інструкції (T023).
    let cu = result.compute_units_consumed;
    assert!(
        cu <= CU_LIMIT,
        "create_token коштує {cu} CU при бюджеті {CU_LIMIT}"
    );
    println!("create_token: {cu} CU із {CU_LIMIT}");

    // Мінт: розширення, знаки, увесь випуск.
    let mint = account_of(&result, &setup.mint);
    assert_eq!(mint.owner, spl_token_2022::ID);
    assert_eq!(hook_program_of(mint), Some(HOOK_PROGRAM_ID));
    let base = mint_base(mint);
    assert_eq!(base.decimals, DECIMALS);
    assert_eq!(base.supply, SUPPLY);
    // Заморожування рахунків у політику не входить — правило виконує хук.
    assert_eq!(Option::<Pubkey>::from(base.freeze_authority), None);

    // Метадані вказують самі на себе і читаються гаманцем із мінта.
    assert_eq!(metadata_address_of(mint), Some(setup.mint));
    let metadata = mint_metadata(mint);
    assert_eq!(metadata.name, "Acme Series A");
    assert_eq!(metadata.symbol, "ACME");
    assert_eq!(metadata.uri, "https://example.com/acme.json");
    assert_eq!(metadata.mint, setup.mint);

    // Казначейство — ATA під `Company` PDA, і в ньому весь випуск.
    let treasury = account_of(&result, &setup.treasury);
    assert_eq!(treasury.owner, spl_token_2022::ID);
    assert_eq!(token_amount(&result, &setup.treasury), SUPPLY);

    // Список додаткових акаунтів існує вже після створення токена (його за
    // CPI створила програма-хук, тож і належить він їй): без нього перший же
    // переказ не зміг би зібрати акаунти для хука.
    let metas = account_of(&result, &setup.extra_metas);
    assert_eq!(metas.owner, HOOK_PROGRAM_ID);
    assert_eq!(
        metas.data.len(),
        ExtraAccountMetaList::size_of(EXTRA_ACCOUNT_COUNT).expect("розмір списку")
    );

    let config: TokenConfig = read(&result, &setup.token_config);
    assert_eq!(config.company, setup.company);
    assert_eq!(config.mint, setup.mint);
    assert_eq!(config.treasury_owner, setup.company);
    assert_eq!(config.policy, policy());
    assert_eq!(config.policy_version, 1);
    assert_eq!(config.decimals, DECIMALS);
    assert_eq!(config.total_supply, SUPPLY);

    let company: Company = read(&result, &setup.company);
    assert_eq!(company.token_count, 1);

    let emitted = events::<TokenCreated>(&take_logs(&mollusk));
    assert_eq!(emitted.len(), 1);
    let event = &emitted[0];
    assert_eq!(event.company, setup.company);
    assert_eq!(event.mint, setup.mint);
    assert_eq!(event.treasury, setup.treasury);
    assert_eq!(event.name, "Acme Series A");
    assert_eq!(event.symbol, "ACME");
    assert_eq!(event.decimals, DECIMALS);
    assert_eq!(event.total_supply, SUPPLY);
    assert_eq!(event.policy, policy());
    assert_eq!(event.policy_version, 1);
}

/// «Емісія один раз» має читатися з мінта, а не з нашого коду: право емісії
/// віддане в тій самій інструкції, тож довипуск неможливий ніким і ніколи.
#[test]
fn revokes_the_mint_authority_in_the_same_instruction() {
    let mollusk = mollusk();
    let setup = setup(&mollusk, 0);

    let result = create(&mollusk, &setup, args());
    assert!(is_success(&result), "{:?}", result.program_result);
    assert_eq!(mint_authority_of(account_of(&result, &setup.mint)), None);
}

/// Порожній `uri` дозволений: гаманець покаже назву й символ і без посилання.
#[test]
fn accepts_an_empty_uri() {
    let mollusk = mollusk();
    let setup = setup(&mollusk, 0);

    let result = create(
        &mollusk,
        &setup,
        CreateTokenArgs {
            uri: String::new(),
            ..args()
        },
    );
    assert!(is_success(&result), "{:?}", result.program_result);
    assert_eq!(mint_metadata(account_of(&result, &setup.mint)).uri, "");
}

/// Другий токен тієї ж компанії: `token_count` уже 1, тож адреса мінта інша.
#[test]
fn derives_a_different_mint_for_the_next_token_of_the_same_company() {
    let mollusk = mollusk();
    let first = setup(&mollusk, 0);
    let second = setup(&mollusk, 1);
    assert_ne!(first.mint, second.mint);

    let result = create(&mollusk, &second, args());
    assert!(is_success(&result), "{:?}", result.program_result);
    assert_eq!(read::<Company>(&result, &second.company).token_count, 2);
}

/// Мінт за індексом, який не збігається з `token_count`, — інша адреса, і
/// Anchor ловить це до хендлера.
#[test]
fn rejects_a_mint_pda_that_does_not_match_the_token_count() {
    let mollusk = mollusk();
    let mut setup = setup(&mollusk, 0);
    let (wrong_mint, _) = TokenConfig::find_mint_address(&setup.company, 5);
    let (wrong_config, _) = TokenConfig::find_address(&wrong_mint);
    setup.mint = wrong_mint;
    setup.token_config = wrong_config;
    setup.treasury = ata(&setup.company, &wrong_mint);
    setup.extra_metas = get_extra_account_metas_address(&wrong_mint, &HOOK_PROGRAM_ID);
    setup.accounts[2] = empty(wrong_mint);
    setup.accounts[3] = empty(wrong_config);
    setup.accounts[4] = empty(setup.treasury);
    setup.accounts[5] = empty(setup.extra_metas);

    let result = create(&mollusk, &setup, args());
    assert_eq!(
        custom_error_code(&result),
        Some(anchor_code(ErrorCode::ConstraintSeeds)),
        "{:?}",
        result.program_result
    );
}

/// FR-004: токен випускає адміністратор. Чужий підпис не проходить навіть із
/// правильними PDA.
#[test]
fn rejects_a_signer_who_is_not_the_company_admin() {
    let mollusk = mollusk();
    let mut setup = setup(&mollusk, 0);
    let stranger = Pubkey::new_unique();
    setup.accounts[0] = (stranger, funded_wallet());
    setup.admin = stranger;

    let result = create(&mollusk, &setup, args());
    assert_eq!(
        custom_error_code(&result),
        Some(expected(CaprailError::Unauthorized)),
        "{:?}",
        result.program_result
    );
}

/// До M4 політика з ROFR неможлива: стан «увімкнено, а механізму немає» не має
/// існувати на жодній віхі.
#[test]
fn rejects_a_policy_that_requires_rofr() {
    let mollusk = mollusk();
    let setup = setup(&mollusk, 0);

    let result = create(
        &mollusk,
        &setup,
        CreateTokenArgs {
            policy: TransferPolicy {
                require_rofr: true,
                ..policy()
            },
            ..args()
        },
    );
    assert_eq!(
        custom_error_code(&result),
        Some(expected(CaprailError::RofrNotSupported)),
        "{:?}",
        result.program_result
    );
}

#[test]
fn rejects_out_of_range_arguments() {
    let mollusk = mollusk();
    let long_name = "x".repeat(33);
    let long_symbol = "x".repeat(TOKEN_SYMBOL_MAX + 1);
    let long_uri = "x".repeat(TOKEN_URI_MAX + 1);

    let cases: [(CreateTokenArgs, CaprailError); 7] = [
        (
            CreateTokenArgs {
                name: String::new(),
                ..args()
            },
            CaprailError::InvalidName,
        ),
        (
            CreateTokenArgs {
                name: long_name,
                ..args()
            },
            CaprailError::InvalidName,
        ),
        (
            CreateTokenArgs {
                symbol: String::new(),
                ..args()
            },
            CaprailError::InvalidMetadata,
        ),
        (
            CreateTokenArgs {
                symbol: long_symbol,
                ..args()
            },
            CaprailError::InvalidMetadata,
        ),
        (
            CreateTokenArgs {
                uri: long_uri,
                ..args()
            },
            CaprailError::InvalidMetadata,
        ),
        (
            CreateTokenArgs {
                total_supply: 0,
                ..args()
            },
            CaprailError::InvalidSupply,
        ),
        (
            CreateTokenArgs {
                decimals: DECIMALS_MAX + 1,
                ..args()
            },
            CaprailError::InvalidSupply,
        ),
    ];

    for (args, expect) in cases {
        let setup = setup(&mollusk, 0);
        let label = format!("{args:?}");
        let result = create(&mollusk, &setup, args);
        assert_eq!(
            custom_error_code(&result),
            Some(expected(expect)),
            "{label}: {:?}",
            result.program_result
        );
        // Жодного часткового стану: мінта немає так само, як і конфігурації.
        assert!(account_of(&result, &setup.mint).data.is_empty());
        assert!(account_of(&result, &setup.token_config).data.is_empty());
        assert!(account_of(&result, &setup.extra_metas).data.is_empty());
    }
}

/// Вікно ROFR понад місяць — помилка вводу, а не політика; ту саму перевірку
/// успадкує `set_policy` (T019).
#[test]
fn rejects_a_rofr_window_over_the_cap() {
    let mollusk = mollusk();
    let setup = setup(&mollusk, 0);

    let result = create(
        &mollusk,
        &setup,
        CreateTokenArgs {
            policy: TransferPolicy {
                rofr_window_secs: ROFR_WINDOW_MAX_SECS + 1,
                ..policy()
            },
            ..args()
        },
    );
    assert_eq!(
        custom_error_code(&result),
        Some(expected(CaprailError::InvalidPolicy)),
        "{:?}",
        result.program_result
    );
}
