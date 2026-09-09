//! `distribute` (T022): частка йде з казначейства інвестору через хук.
//!
//! Тут не повторюються тести правила — воно вже доведене в
//! `hook_admission.rs`. Тут доводиться, що розподіл **іде тим самим шляхом**:
//! підпис `Company` PDA приймає Token-2022, хвіст акаунтів доходить до
//! `execute`, недопущений одержувач відхиляється хуком, а не нами, і журнал
//! отримує `TransferAllowed` із `from_treasury = true`.

mod common;

use anchor_lang::prelude::Pubkey;
use anchor_lang::{InstructionData, ToAccountMetas};
use anchor_spl::token_2022::spl_token_2022;
use caprail::events::TransferAllowed;
use caprail::hook::{extra_account_metas, EXTRA_ACCOUNT_COUNT, HOOK_PROGRAM_ID};
use caprail::state::{
    Company, InvestorRecord, InvestorStatus, TokenConfig, TransferPolicy, GRANT_SEED, PERMIT_SEED,
};
use caprail::CaprailError;
use common::*;
use mollusk_svm::result::InstructionResult;
use mollusk_svm::Mollusk;
use solana_account::Account;
use solana_instruction::Instruction;
use spl_tlv_account_resolution::state::ExtraAccountMetaList;
use spl_transfer_hook_interface::get_extra_account_metas_address;
use spl_transfer_hook_interface::instruction::ExecuteInstruction;

const COMPANY_ID: u64 = 11;
const SUPPLY: u64 = 1_000_000;
const AMOUNT: u64 = 2_500;
const YEAR: i64 = 365 * 24 * 60 * 60;

/// Компанія з випущеним токеном і одним інвестором: усе, що потрібно
/// `distribute`, крім самого рахунку інвестора — той інструкція створює сама.
struct World {
    admin: Pubkey,
    officer: Pubkey,
    company: Pubkey,
    mint: Pubkey,
    token_config: Pubkey,
    treasury: Pubkey,
    list: Pubkey,
    investor: Pubkey,
    investor_ata: Pubkey,
    record: Pubkey,
    accounts: Vec<(Pubkey, Account)>,
}

fn world(mollusk: &Mollusk, registry: Option<(InvestorStatus, i64)>) -> World {
    let admin = Pubkey::new_unique();
    let officer = Pubkey::new_unique();
    let investor = Pubkey::new_unique();
    let (company, company_bump) = Company::find_address(COMPANY_ID);
    let (mint, _) = TokenConfig::find_mint_address(&company, 0);
    let (token_config, config_bump) = TokenConfig::find_address(&mint);
    let treasury = ata(&company, &mint);
    let list = get_extra_account_metas_address(&mint, &HOOK_PROGRAM_ID);
    let investor_ata = ata(&investor, &mint);
    let (record, record_bump) = InvestorRecord::find_address(&mint, &investor);

    let company_state = Company {
        company_id: COMPANY_ID,
        admin,
        compliance_officer: officer,
        name: [b'x'; Company::NAME_LEN],
        token_count: 1,
        bump: company_bump,
    };
    let config_state = TokenConfig {
        company,
        mint,
        treasury_owner: company,
        policy: TransferPolicy {
            require_accreditation: true,
            require_rofr: false,
            rofr_window_secs: 0,
        },
        policy_version: 1,
        decimals: DECIMALS,
        total_supply: SUPPLY,
        bump: config_bump,
    };
    let mut list_data = vec![
        0u8;
        ExtraAccountMetaList::size_of(EXTRA_ACCOUNT_COUNT)
            .expect("розмір списку")
    ];
    ExtraAccountMetaList::init::<ExecuteInstruction>(
        &mut list_data,
        &extra_account_metas().expect("список акаунтів хука"),
    )
    .expect("список має пакуватись");

    let record_account = match registry {
        None => Account::default(),
        Some((status, expires_at)) => anchor_account(
            mollusk,
            &InvestorRecord {
                mint,
                wallet: investor,
                status,
                expires_at,
                jurisdiction: *b"UA",
                investor_type: 1,
                updated_at: GENESIS_UNIX_TS,
                updated_by: officer,
                bump: record_bump,
            },
        ),
    };

    World {
        admin,
        officer,
        company,
        mint,
        token_config,
        treasury,
        list,
        investor,
        investor_ata,
        record,
        accounts: vec![
            (admin, funded_wallet()),
            (officer, funded_wallet()),
            (company, anchor_account(mollusk, &company_state)),
            (token_config, anchor_account(mollusk, &config_state)),
            (mint, hook_mint(mollusk, &company, SUPPLY, DECIMALS)),
            (
                treasury,
                hook_token_account(mollusk, &mint, &company, SUPPLY),
            ),
            (list, rent_exempt(mollusk, list_data, HOOK_PROGRAM_ID)),
            (investor, funded_wallet()),
            empty(investor_ata),
            (record, record_account),
            empty(grant_of(&mint, &company)),
            empty(permit_of(&treasury)),
            caprail_program(),
            hook_program(),
            token_program(),
            ata_program(),
            system_program(),
        ],
    }
}

fn grant_of(mint: &Pubkey, sender: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[GRANT_SEED, mint.as_ref(), sender.as_ref()], &caprail::ID).0
}

fn permit_of(source: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[PERMIT_SEED, source.as_ref()], &caprail::ID).0
}

fn instruction(world: &World, signer: &Pubkey, amount: u64) -> Instruction {
    Instruction {
        program_id: caprail::ID,
        accounts: caprail::accounts::Distribute {
            admin: *signer,
            company: world.company,
            token_config: world.token_config,
            mint: world.mint,
            treasury: world.treasury,
            investor: world.investor,
            investor_token_account: world.investor_ata,
            extra_account_meta_list: world.list,
            state_program: caprail::ID,
            investor_record: world.record,
            grant: grant_of(&world.mint, &world.company),
            transfer_permit: permit_of(&world.treasury),
            hook_program: HOOK_PROGRAM_ID,
            token_program: spl_token_2022::ID,
            associated_token_program: anchor_spl::associated_token::ID,
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
        data: caprail::instruction::Distribute { amount }.data(),
    }
}

fn run(mollusk: &Mollusk, world: &World, amount: u64) -> InstructionResult {
    mollusk.process_instruction(&instruction(world, &world.admin, amount), &world.accounts)
}

fn allowed(mollusk: &Mollusk) -> Vec<TransferAllowed> {
    events::<TransferAllowed>(&take_logs(mollusk))
}

/// Щасливий шлях: рахунок інвестора з'являється в тій самій інструкції, частка
/// на ньому, казначейство зменшилось рівно на неї, і журнал бачить розподіл
/// як переказ із казначейства.
#[test]
fn admin_distributes_to_an_admitted_investor_and_creates_the_account() {
    let mollusk = mollusk();
    let world = world(
        &mollusk,
        Some((InvestorStatus::Approved, now(&mollusk) + YEAR)),
    );

    let result = run(&mollusk, &world, AMOUNT);
    assert!(is_success(&result), "{:?}", result.program_result);
    assert_eq!(token_amount(&result, &world.investor_ata), AMOUNT);
    assert_eq!(token_amount(&result, &world.treasury), SUPPLY - AMOUNT);

    // Найважчий шлях розподілу — зі створенням рахунку — у бюджеті інструкції
    // (T023); число йде в таблицю M1.
    let cu = result.compute_units_consumed;
    assert!(
        cu <= CU_LIMIT,
        "distribute коштує {cu} CU при бюджеті {CU_LIMIT}"
    );
    println!("distribute зі створенням ATA: {cu} CU із {CU_LIMIT}");

    let events = allowed(&mollusk);
    assert_eq!(
        events.len(),
        1,
        "розподіл — один рядок журналу, і той від хука"
    );
    let event = &events[0];
    assert!(event.from_treasury);
    assert_eq!(event.source_owner, world.company);
    assert_eq!(event.destination_owner, world.investor);
    assert_eq!(event.destination, world.investor_ata);
    assert_eq!(event.amount, AMOUNT);
    assert_eq!(event.mint, world.mint);
}

/// Рахунок, що вже існує, не перестворюється — частка додається.
#[test]
fn reuses_an_existing_investor_account() {
    let mollusk = mollusk();
    let mut world = world(
        &mollusk,
        Some((InvestorStatus::Approved, now(&mollusk) + YEAR)),
    );
    let existing = world
        .accounts
        .iter_mut()
        .find(|(key, _)| *key == world.investor_ata)
        .expect("рахунок інвестора в стенді");
    existing.1 = hook_token_account(&mollusk, &world.mint, &world.investor, 100);

    let result = run(&mollusk, &world, AMOUNT);
    assert!(is_success(&result), "{:?}", result.program_result);
    assert_eq!(token_amount(&result, &world.investor_ata), 100 + AMOUNT);
}

/// Недопущеного відхиляє хук — тією самою причиною, що й для стороннього
/// гаманця; рахунок при цьому не створюється, казначейство не змінюється.
#[test]
fn the_hook_rejects_a_distribution_to_an_unadmitted_investor() {
    let mollusk = mollusk();
    for registry in [
        None,
        Some((InvestorStatus::None, GENESIS_UNIX_TS + YEAR)),
        Some((InvestorStatus::Revoked, GENESIS_UNIX_TS + YEAR)),
    ] {
        let world = world(&mollusk, registry);
        let result = run(&mollusk, &world, AMOUNT);
        assert_eq!(
            custom_error_code(&result),
            Some(expected(CaprailError::NotAccredited)),
            "{registry:?}: {:?}",
            result.program_result
        );
        assert_eq!(token_amount(&result, &world.treasury), SUPPLY);
        assert!(account_of(&result, &world.investor_ata).data.is_empty());
        assert!(allowed(&mollusk).is_empty());
    }

    let world = world(
        &mollusk,
        Some((InvestorStatus::Approved, now(&mollusk) - 1)),
    );
    let result = run(&mollusk, &world, AMOUNT);
    assert_eq!(
        custom_error_code(&result),
        Some(expected(CaprailError::AccreditationExpired)),
        "{:?}",
        result.program_result
    );
}

/// Допуск відкликано після отримання: частка лишається в інвестора, але
/// наступний переказ йому відхиляється. Стан між кроками — результат першої
/// інструкції, як у мережі.
#[test]
fn revoking_admission_keeps_the_stake_but_blocks_the_next_transfer() {
    let mollusk = mollusk();
    let mut world = world(
        &mollusk,
        Some((InvestorStatus::Approved, now(&mollusk) + YEAR)),
    );

    let first = run(&mollusk, &world, AMOUNT);
    assert!(is_success(&first), "{:?}", first.program_result);
    assert_eq!(allowed(&mollusk).len(), 1);

    // Офіцер відкликає допуск: у стенді — той самий запис зі статусом `Revoked`
    // (шлях через `set_investor_status` доведений у `investor_registry.rs`).
    let (_, record_bump) = InvestorRecord::find_address(&world.mint, &world.investor);
    let revoked = anchor_account(
        &mollusk,
        &InvestorRecord {
            mint: world.mint,
            wallet: world.investor,
            status: InvestorStatus::Revoked,
            expires_at: now(&mollusk) + YEAR,
            jurisdiction: *b"UA",
            investor_type: 1,
            updated_at: now(&mollusk),
            updated_by: world.officer,
            bump: record_bump,
        },
    );
    world.accounts = first
        .resulting_accounts
        .iter()
        .map(|(key, account)| {
            if *key == world.record {
                (*key, revoked.clone())
            } else {
                (*key, account.clone())
            }
        })
        .collect();

    let second = run(&mollusk, &world, AMOUNT);
    assert_eq!(
        custom_error_code(&second),
        Some(expected(CaprailError::NotAccredited)),
        "{:?}",
        second.program_result
    );
    assert_eq!(token_amount(&second, &world.investor_ata), AMOUNT);
    assert_eq!(token_amount(&second, &world.treasury), SUPPLY - AMOUNT);
    assert!(allowed(&mollusk).is_empty());
}

/// Розподіляє адміністратор; комплаєнс-офіцер не може (FR-004).
#[test]
fn the_compliance_officer_cannot_distribute() {
    let mollusk = mollusk();
    let world = world(
        &mollusk,
        Some((InvestorStatus::Approved, now(&mollusk) + YEAR)),
    );
    let result = mollusk.process_instruction(
        &instruction(&world, &world.officer, AMOUNT),
        &world.accounts,
    );
    assert_eq!(
        custom_error_code(&result),
        Some(expected(CaprailError::Unauthorized)),
        "{:?}",
        result.program_result
    );
    assert_eq!(token_amount(&result, &world.treasury), SUPPLY);
}

/// Нульовий розподіл — не переказ; хук інакше записав би його в журнал.
#[test]
fn rejects_a_zero_amount() {
    let mollusk = mollusk();
    let world = world(
        &mollusk,
        Some((InvestorStatus::Approved, now(&mollusk) + YEAR)),
    );
    let result = run(&mollusk, &world, 0);
    assert_eq!(
        custom_error_code(&result),
        Some(expected(CaprailError::InvalidAmount)),
        "{:?}",
        result.program_result
    );
    assert!(allowed(&mollusk).is_empty());
}

/// Понад казначейство — відмова Token-2022, без часткового стану.
#[test]
fn cannot_distribute_more_than_the_treasury_holds() {
    let mollusk = mollusk();
    let world = world(
        &mollusk,
        Some((InvestorStatus::Approved, now(&mollusk) + YEAR)),
    );
    let result = run(&mollusk, &world, SUPPLY + 1);
    assert!(!is_success(&result));
    assert_eq!(token_amount(&result, &world.treasury), SUPPLY);
    assert!(allowed(&mollusk).is_empty());
}

/// Конфіг чужої компанії під нашим підписом — ізоляція компаній (FR-018).
#[test]
fn rejects_a_token_config_of_another_company() {
    let mollusk = mollusk();
    let mut world = world(
        &mollusk,
        Some((InvestorStatus::Approved, now(&mollusk) + YEAR)),
    );
    let (other_company, _) = Company::find_address(COMPANY_ID + 1);
    let (other_mint, _) = TokenConfig::find_mint_address(&other_company, 0);
    let (other_config, bump) = TokenConfig::find_address(&other_mint);
    world.accounts.push((
        other_config,
        anchor_account(
            &mollusk,
            &TokenConfig {
                company: other_company,
                mint: other_mint,
                treasury_owner: other_company,
                policy: TransferPolicy {
                    require_accreditation: true,
                    require_rofr: false,
                    rofr_window_secs: 0,
                },
                policy_version: 1,
                decimals: DECIMALS,
                total_supply: SUPPLY,
                bump,
            },
        ),
    ));
    world.token_config = other_config;

    let result = run(&mollusk, &world, AMOUNT);
    assert_eq!(
        custom_error_code(&result),
        Some(expected(CaprailError::Unauthorized)),
        "{:?}",
        result.program_result
    );
}
