//! `set_policy` і `set_roles` (T019): хто змінює правила компанії і що з цього
//! бачить індекс.
//!
//! Стан тут будується напряму (`anchor_account`), а не прогоном `create_company`
//! і `create_token`: перевіряються самі інструкції зміни, і зайві кроки лише
//! ховали б причину падіння.

mod common;

use anchor_lang::prelude::Pubkey;
use anchor_lang::{InstructionData, ToAccountMetas};
use caprail::events::{PolicySet, RolesSet};
use caprail::state::{Company, TokenConfig, TransferPolicy, ROFR_WINDOW_MAX_SECS};
use caprail::CaprailError;
use common::*;
use mollusk_svm::result::InstructionResult;
use mollusk_svm::Mollusk;
use solana_account::Account;
use solana_instruction::Instruction;

const COMPANY_ID: u64 = 11;

fn strict() -> TransferPolicy {
    TransferPolicy {
        require_accreditation: true,
        require_rofr: false,
        rofr_window_secs: 0,
    }
}

fn open() -> TransferPolicy {
    TransferPolicy {
        require_accreditation: false,
        require_rofr: false,
        rofr_window_secs: 7 * 24 * 60 * 60,
    }
}

struct World {
    admin: Pubkey,
    officer: Pubkey,
    company: Pubkey,
    mint: Pubkey,
    token_config: Pubkey,
    accounts: Vec<(Pubkey, Account)>,
}

fn world(mollusk: &Mollusk) -> World {
    let admin = Pubkey::new_unique();
    let officer = Pubkey::new_unique();
    let (company, company_bump) = Company::find_address(COMPANY_ID);
    let (mint, _) = TokenConfig::find_mint_address(&company, 0);
    let (token_config, config_bump) = TokenConfig::find_address(&mint);

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
        policy: strict(),
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
        accounts: vec![
            (admin, funded_wallet()),
            (officer, funded_wallet()),
            (company, anchor_account(mollusk, &company_state)),
            (token_config, anchor_account(mollusk, &config_state)),
        ],
    }
}

fn set_policy_ix(signer: &Pubkey, world: &World, policy: TransferPolicy) -> Instruction {
    Instruction {
        program_id: caprail::ID,
        accounts: caprail::accounts::SetPolicy {
            admin: *signer,
            company: world.company,
            token_config: world.token_config,
        }
        .to_account_metas(None),
        data: caprail::instruction::SetPolicy { policy }.data(),
    }
}

fn set_roles_ix(
    signer: &Pubkey,
    world: &World,
    admin: Pubkey,
    compliance_officer: Pubkey,
) -> Instruction {
    Instruction {
        program_id: caprail::ID,
        accounts: caprail::accounts::SetRoles {
            admin: *signer,
            company: world.company,
        }
        .to_account_metas(None),
        data: caprail::instruction::SetRoles {
            admin,
            compliance_officer,
        }
        .data(),
    }
}

fn run(mollusk: &Mollusk, world: &World, instruction: &Instruction) -> InstructionResult {
    mollusk.process_instruction(instruction, &world.accounts)
}

#[test]
fn admin_replaces_the_policy_and_bumps_the_version() {
    let mollusk = mollusk();
    let world = world(&mollusk);

    let result = run(
        &mollusk,
        &world,
        &set_policy_ix(&world.admin, &world, open()),
    );
    assert!(is_success(&result), "{:?}", result.program_result);

    let config: TokenConfig = read(&result, &world.token_config);
    assert_eq!(config.policy, open());
    assert_eq!(config.policy_version, 2);
    // Політика — єдине, що змінилось: випуск і казначейство інструкції не чіпає.
    assert_eq!(config.total_supply, 1_000);
    assert_eq!(config.treasury_owner, world.company);

    let emitted = events::<PolicySet>(&take_logs(&mollusk));
    assert_eq!(emitted.len(), 1);
    let event = &emitted[0];
    assert_eq!(event.company, world.company);
    assert_eq!(event.mint, world.mint);
    assert_eq!(event.policy, open());
    assert_eq!(event.policy_version, 2);
    assert_eq!(event.set_at, now(&mollusk));
}

/// FR-004: комплаєнс-офіцер веде реєстр, але політику не міняє — навіть своїм
/// ключем і з правильними акаунтами.
#[test]
fn the_compliance_officer_cannot_change_the_policy() {
    let mollusk = mollusk();
    let world = world(&mollusk);

    let result = run(
        &mollusk,
        &world,
        &set_policy_ix(&world.officer, &world, open()),
    );
    assert_eq!(
        custom_error_code(&result),
        Some(expected(CaprailError::Unauthorized)),
        "{:?}",
        result.program_result
    );
    assert_eq!(
        read::<TokenConfig>(&result, &world.token_config).policy,
        strict()
    );
}

/// Обмеження політики однакові при випуску і при зміні: інакше стан, який
/// `create_token` відхиляє, з'являвся б через `set_policy`.
#[test]
fn rejects_the_same_policies_as_token_creation() {
    let mollusk = mollusk();

    let cases = [
        (
            TransferPolicy {
                require_rofr: true,
                ..strict()
            },
            CaprailError::RofrNotSupported,
        ),
        (
            TransferPolicy {
                rofr_window_secs: ROFR_WINDOW_MAX_SECS + 1,
                ..strict()
            },
            CaprailError::InvalidPolicy,
        ),
    ];

    for (policy, expect) in cases {
        let world = world(&mollusk);
        let result = run(
            &mollusk,
            &world,
            &set_policy_ix(&world.admin, &world, policy),
        );
        assert_eq!(
            custom_error_code(&result),
            Some(expected(expect)),
            "{policy:?}: {:?}",
            result.program_result
        );
        // Невдала зміна не рухає ні політику, ні версію.
        let config: TokenConfig = read(&result, &world.token_config);
        assert_eq!(config.policy, strict());
        assert_eq!(config.policy_version, 1);
    }
}

/// FR-018: `TokenConfig` чужої компанії не піддається навіть власному адміну —
/// зв'язок тримає `has_one = company`.
#[test]
fn rejects_a_token_config_of_another_company() {
    let mollusk = mollusk();
    let mut world = world(&mollusk);

    let (other_company, _) = Company::find_address(COMPANY_ID + 1);
    let (other_mint, _) = TokenConfig::find_mint_address(&other_company, 0);
    let (other_config, other_bump) = TokenConfig::find_address(&other_mint);
    let foreign = TokenConfig {
        company: other_company,
        mint: other_mint,
        treasury_owner: other_company,
        policy: strict(),
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
        &set_policy_ix(&world.admin, &world, open()),
    );
    assert_eq!(
        custom_error_code(&result),
        Some(expected(CaprailError::Unauthorized)),
        "{:?}",
        result.program_result
    );
}

#[test]
fn admin_hands_over_both_roles() {
    let mollusk = mollusk();
    let world = world(&mollusk);
    let next_admin = Pubkey::new_unique();
    let next_officer = Pubkey::new_unique();

    let result = run(
        &mollusk,
        &world,
        &set_roles_ix(&world.admin, &world, next_admin, next_officer),
    );
    assert!(is_success(&result), "{:?}", result.program_result);

    let company: Company = read(&result, &world.company);
    assert_eq!(company.admin, next_admin);
    assert_eq!(company.compliance_officer, next_officer);
    // Решта компанії не рухається: токени лишаються її токенами.
    assert_eq!(company.company_id, COMPANY_ID);
    assert_eq!(company.token_count, 1);

    let emitted = events::<RolesSet>(&take_logs(&mollusk));
    assert_eq!(emitted.len(), 1);
    assert_eq!(emitted[0].admin, next_admin);
    assert_eq!(emitted[0].compliance_officer, next_officer);
    assert_eq!(emitted[0].set_at, now(&mollusk));
}

/// Передача — справжня: попередній адміністратор одразу втрачає право на
/// політику. Це і є сенс операції, і саме це має бути під тестом.
#[test]
fn the_previous_admin_loses_the_rights_immediately() {
    let mollusk = mollusk();
    let world = world(&mollusk);
    let next_admin = Pubkey::new_unique();
    let next_officer = Pubkey::new_unique();

    let result = mollusk.process_instruction_chain(
        &[
            set_roles_ix(&world.admin, &world, next_admin, next_officer),
            set_policy_ix(&world.admin, &world, open()),
        ],
        &world.accounts,
    );

    assert_eq!(
        custom_error_code(&result),
        Some(expected(CaprailError::Unauthorized)),
        "{:?}",
        result.program_result
    );
    assert_eq!(
        read::<TokenConfig>(&result, &world.token_config).policy,
        strict()
    );
}

#[test]
fn rejects_roles_that_are_one_key_or_zero() {
    let mollusk = mollusk();
    let other = Pubkey::new_unique();

    let cases = [
        (other, other),
        (Pubkey::default(), other),
        (other, Pubkey::default()),
    ];

    for (admin, officer) in cases {
        let world = world(&mollusk);
        let result = run(
            &mollusk,
            &world,
            &set_roles_ix(&world.admin, &world, admin, officer),
        );
        assert_eq!(
            custom_error_code(&result),
            Some(expected(CaprailError::InvalidRoles)),
            "{admin}/{officer}: {:?}",
            result.program_result
        );
        let company: Company = read(&result, &world.company);
        assert_eq!(company.admin, world.admin);
        assert_eq!(company.compliance_officer, world.officer);
    }
}

/// Офіцер не може ні призначити себе адміністратором, ні змінити ролі взагалі.
#[test]
fn the_compliance_officer_cannot_change_the_roles() {
    let mollusk = mollusk();
    let world = world(&mollusk);

    let result = run(
        &mollusk,
        &world,
        &set_roles_ix(&world.officer, &world, world.officer, world.admin),
    );
    assert_eq!(
        custom_error_code(&result),
        Some(expected(CaprailError::Unauthorized)),
        "{:?}",
        result.program_result
    );
    assert_eq!(read::<Company>(&result, &world.company).admin, world.admin);
}
