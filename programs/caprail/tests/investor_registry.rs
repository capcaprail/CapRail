//! `set_investor_status` (T020): реєстр інвесторів веде комплаєнс-офіцер.
//!
//! Головне тут не поля, а межа ролей: адміністратор компанії — не офіцер, і
//! статус допуску його підписом не ставиться (FR-004). Решта — що запис
//! створюється за seeds, які потім шукатиме хук, і що подія несе все для
//! індексу й історії.

mod common;

use anchor_lang::prelude::Pubkey;
use anchor_lang::{InstructionData, ToAccountMetas};
use caprail::events::InvestorStatusSet;
use caprail::instructions::SetInvestorStatusArgs;
use caprail::state::{Company, InvestorRecord, InvestorStatus, TokenConfig, TransferPolicy};
use caprail::CaprailError;
use common::*;
use mollusk_svm::result::InstructionResult;
use mollusk_svm::Mollusk;
use solana_account::Account;
use solana_instruction::Instruction;

const COMPANY_ID: u64 = 3;
const YEAR: i64 = 365 * 24 * 60 * 60;

struct World {
    admin: Pubkey,
    officer: Pubkey,
    company: Pubkey,
    mint: Pubkey,
    token_config: Pubkey,
    investor: Pubkey,
    record: Pubkey,
    accounts: Vec<(Pubkey, Account)>,
}

fn world(mollusk: &Mollusk) -> World {
    let admin = Pubkey::new_unique();
    let officer = Pubkey::new_unique();
    let investor = Pubkey::new_unique();
    let (company, company_bump) = Company::find_address(COMPANY_ID);
    let (mint, _) = TokenConfig::find_mint_address(&company, 0);
    let (token_config, config_bump) = TokenConfig::find_address(&mint);
    let (record, _) = InvestorRecord::find_address(&mint, &investor);

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
        decimals: 0,
        total_supply: 1_000,
        bump: config_bump,
    };

    World {
        admin,
        officer,
        company,
        mint,
        token_config,
        investor,
        record,
        accounts: vec![
            (admin, funded_wallet()),
            (officer, funded_wallet()),
            (company, anchor_account(mollusk, &company_state)),
            (token_config, anchor_account(mollusk, &config_state)),
            empty(record),
            system_program(),
        ],
    }
}

fn args(world: &World, status: InvestorStatus, expires_at: i64) -> SetInvestorStatusArgs {
    SetInvestorStatusArgs {
        wallet: world.investor,
        status,
        expires_at,
        jurisdiction: *b"UA",
        investor_type: 1,
    }
}

fn instruction(signer: &Pubkey, world: &World, args: SetInvestorStatusArgs) -> Instruction {
    Instruction {
        program_id: caprail::ID,
        accounts: caprail::accounts::SetInvestorStatus {
            compliance_officer: *signer,
            company: world.company,
            token_config: world.token_config,
            investor_record: world.record,
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
        data: caprail::instruction::SetInvestorStatus { args }.data(),
    }
}

fn run(
    mollusk: &Mollusk,
    world: &World,
    signer: &Pubkey,
    args: SetInvestorStatusArgs,
) -> InstructionResult {
    mollusk.process_instruction(&instruction(signer, world, args), &world.accounts)
}

#[test]
fn the_officer_creates_the_record_and_the_event_carries_the_registry_row() {
    let mollusk = mollusk();
    let world = world(&mollusk);
    let expires_at = now(&mollusk) + YEAR;

    let result = run(
        &mollusk,
        &world,
        &world.officer,
        args(&world, InvestorStatus::Approved, expires_at),
    );
    assert!(is_success(&result), "{:?}", result.program_result);

    let record: InvestorRecord = read(&result, &world.record);
    assert_eq!(record.mint, world.mint);
    assert_eq!(record.wallet, world.investor);
    assert_eq!(record.status, InvestorStatus::Approved);
    assert_eq!(record.expires_at, expires_at);
    assert_eq!(&record.jurisdiction, b"UA");
    assert_eq!(record.investor_type, 1);
    assert_eq!(record.updated_at, now(&mollusk));
    // Хто змінив — частина реєстру (FR-003), а не лише журналу.
    assert_eq!(record.updated_by, world.officer);
    assert_eq!(
        record.bump,
        InvestorRecord::find_address(&world.mint, &world.investor).1
    );

    let emitted = events::<InvestorStatusSet>(&take_logs(&mollusk));
    assert_eq!(emitted.len(), 1);
    let event = &emitted[0];
    assert_eq!(event.company, world.company);
    assert_eq!(event.mint, world.mint);
    assert_eq!(event.wallet, world.investor);
    assert_eq!(event.status, InvestorStatus::Approved);
    assert_eq!(event.expires_at, expires_at);
    assert_eq!(event.updated_by, world.officer);
}

/// FR-004 у найгострішій формі: адміністратор керує токеном і політикою, але
/// допуск собі чи будь-кому не ставить.
#[test]
fn the_admin_cannot_set_a_status() {
    let mollusk = mollusk();
    let world = world(&mollusk);

    let result = run(
        &mollusk,
        &world,
        &world.admin,
        args(&world, InvestorStatus::Approved, now(&mollusk) + YEAR),
    );
    assert_eq!(
        custom_error_code(&result),
        Some(expected(CaprailError::Unauthorized)),
        "{:?}",
        result.program_result
    );
    assert!(account_of(&result, &world.record).data.is_empty());
}

/// Відкликання — оновлення того самого запису, а не другий запис: адреса PDA
/// одна на пару (mint, гаманець).
#[test]
fn revoking_updates_the_same_record() {
    let mollusk = mollusk();
    let world = world(&mollusk);
    let expires_at = now(&mollusk) + YEAR;

    let result = mollusk.process_instruction_chain(
        &[
            instruction(
                &world.officer,
                &world,
                args(&world, InvestorStatus::Approved, expires_at),
            ),
            instruction(
                &world.officer,
                &world,
                args(&world, InvestorStatus::Revoked, expires_at),
            ),
        ],
        &world.accounts,
    );
    assert!(is_success(&result), "{:?}", result.program_result);

    let record: InvestorRecord = read(&result, &world.record);
    assert_eq!(record.status, InvestorStatus::Revoked);
    assert_eq!(
        account_of(&result, &world.record).data.len(),
        InvestorRecord::SPACE
    );
    assert_eq!(events::<InvestorStatusSet>(&take_logs(&mollusk)).len(), 2);
}

/// `None` — «запис у реєстрі є, допуску немає»: офіцер може занести гаманець
/// із юрисдикцією до рішення про допуск, і строк тут не потрібен.
#[test]
fn accepts_a_registered_wallet_without_admission() {
    let mollusk = mollusk();
    let world = world(&mollusk);

    let result = run(
        &mollusk,
        &world,
        &world.officer,
        args(&world, InvestorStatus::None, 0),
    );
    assert!(is_success(&result), "{:?}", result.program_result);
    assert_eq!(
        read::<InvestorRecord>(&result, &world.record).status,
        InvestorStatus::None
    );
}

/// Допуск, прострочений у момент видачі, — помилка вводу: хук відхилив би
/// переказ на нього з першої ж секунди, і це виглядало б як збій продукту.
#[test]
fn rejects_an_approval_that_is_already_expired() {
    let mollusk = mollusk();
    let world = world(&mollusk);

    for expires_at in [now(&mollusk), now(&mollusk) - 1, 0] {
        let result = run(
            &mollusk,
            &world,
            &world.officer,
            args(&world, InvestorStatus::Approved, expires_at),
        );
        assert_eq!(
            custom_error_code(&result),
            Some(expected(CaprailError::InvalidExpiry)),
            "{expires_at}: {:?}",
            result.program_result
        );
    }
}

#[test]
fn rejects_a_malformed_jurisdiction_but_allows_an_unset_one() {
    let mollusk = mollusk();
    let world = world(&mollusk);
    let expires_at = now(&mollusk) + YEAR;

    for jurisdiction in [*b"ua", *b"U1", [b'U', 0]] {
        let result = run(
            &mollusk,
            &world,
            &world.officer,
            SetInvestorStatusArgs {
                jurisdiction,
                ..args(&world, InvestorStatus::Approved, expires_at)
            },
        );
        assert_eq!(
            custom_error_code(&result),
            Some(expected(CaprailError::InvalidJurisdiction)),
            "{jurisdiction:?}: {:?}",
            result.program_result
        );
    }

    let result = run(
        &mollusk,
        &world,
        &world.officer,
        SetInvestorStatusArgs {
            jurisdiction: [0, 0],
            ..args(&world, InvestorStatus::Approved, expires_at)
        },
    );
    assert!(is_success(&result), "{:?}", result.program_result);
}

/// Запис лягає рівно за тією адресою, яку хук отримає з `ExtraAccountMetaList`
/// (T018) — інакше допущений інвестор виглядав би для правила недопущеним.
#[test]
fn the_record_lands_where_the_hook_will_look_for_it() {
    let mollusk = mollusk();
    let world = world(&mollusk);

    let result = run(
        &mollusk,
        &world,
        &world.officer,
        args(&world, InvestorStatus::Approved, now(&mollusk) + YEAR),
    );
    assert!(is_success(&result), "{:?}", result.program_result);
    assert_eq!(
        world.record,
        Pubkey::find_program_address(
            &[
                InvestorRecord::SEED,
                world.mint.as_ref(),
                world.investor.as_ref()
            ],
            &caprail::ID
        )
        .0
    );
    assert_eq!(account_of(&result, &world.record).owner, caprail::ID);
}

/// FR-018: реєстр однієї компанії ізольований. Атака тут не «підсунути чужий
/// конфіг» (це ловить seeds запису), а підсунути чужий конфіг РАЗОМ із
/// відповідним йому PDA запису — тоді офіцер однієї компанії писав би в реєстр
/// іншої. Зв'язок `TokenConfig ↔ Company` — єдине, що це спиняє.
#[test]
fn rejects_writing_into_the_registry_of_another_company() {
    let mollusk = mollusk();
    let mut world = world(&mollusk);

    let (other_company, _) = Company::find_address(COMPANY_ID + 1);
    let (other_mint, _) = TokenConfig::find_mint_address(&other_company, 0);
    let (other_config, other_bump) = TokenConfig::find_address(&other_mint);
    let (other_record, _) = InvestorRecord::find_address(&other_mint, &world.investor);
    let foreign = TokenConfig {
        company: other_company,
        mint: other_mint,
        treasury_owner: other_company,
        policy: TransferPolicy {
            require_accreditation: true,
            require_rofr: false,
            rofr_window_secs: 0,
        },
        policy_version: 1,
        decimals: 0,
        total_supply: 1_000,
        bump: other_bump,
    };
    world.token_config = other_config;
    world.record = other_record;
    world.accounts[3] = (other_config, anchor_account(&mollusk, &foreign));
    world.accounts[4] = empty(other_record);

    let result = run(
        &mollusk,
        &world,
        &world.officer,
        args(&world, InvestorStatus::Approved, now(&mollusk) + YEAR),
    );
    assert_eq!(
        custom_error_code(&result),
        Some(expected(CaprailError::Unauthorized)),
        "{:?}",
        result.program_result
    );
    assert!(account_of(&result, &other_record).data.is_empty());
}

/// Той самий конфіг, але з «рідним» PDA запису, спиняє інша перевірка — seeds
/// виводяться з `token_config.mint`, і Anchor ловить це ще до ролей.
#[test]
fn rejects_a_record_that_does_not_belong_to_the_configured_mint() {
    let mollusk = mollusk();
    let mut world = world(&mollusk);

    let (other_company, _) = Company::find_address(COMPANY_ID + 1);
    let (other_mint, _) = TokenConfig::find_mint_address(&other_company, 0);
    let (other_config, other_bump) = TokenConfig::find_address(&other_mint);
    let foreign = TokenConfig {
        company: other_company,
        mint: other_mint,
        treasury_owner: other_company,
        policy: TransferPolicy {
            require_accreditation: true,
            require_rofr: false,
            rofr_window_secs: 0,
        },
        policy_version: 1,
        decimals: 0,
        total_supply: 1_000,
        bump: other_bump,
    };
    world.token_config = other_config;
    world.accounts[3] = (other_config, anchor_account(&mollusk, &foreign));

    let result = run(
        &mollusk,
        &world,
        &world.officer,
        args(&world, InvestorStatus::Approved, now(&mollusk) + YEAR),
    );
    assert_eq!(
        custom_error_code(&result),
        Some(anchor_code(anchor_lang::error::ErrorCode::ConstraintSeeds)),
        "{:?}",
        result.program_result
    );
}
