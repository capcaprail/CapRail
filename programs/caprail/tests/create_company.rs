//! `create_company` (T016): PDA компанії з двома ролями, подія для індексу,
//! відмови — по seeds, по ролях, по імені, по повтору. Усе — через зібраний
//! `caprail.so`, тож `init`/`seeds`/`Signer` перевіряє справжній `try_accounts`.

mod common;

use anchor_lang::error::ErrorCode;
use anchor_lang::prelude::Pubkey;
use anchor_lang::{InstructionData, ToAccountMetas};
use caprail::events::CompanyCreated;
use caprail::instructions::CreateCompanyArgs;
use caprail::state::Company;
use caprail::CaprailError;
use common::*;
use mollusk_svm::result::InstructionResult;
use mollusk_svm::Mollusk;
use solana_account::Account;
use solana_instruction::Instruction;

const COMPANY_ID: u64 = 42;

fn args(name: &str, compliance_officer: Pubkey) -> CreateCompanyArgs {
    CreateCompanyArgs {
        company_id: COMPANY_ID,
        compliance_officer,
        name: name.to_string(),
    }
}

fn instruction(admin: &Pubkey, company: &Pubkey, args: CreateCompanyArgs) -> Instruction {
    Instruction {
        program_id: caprail::ID,
        accounts: caprail::accounts::CreateCompany {
            admin: *admin,
            company: *company,
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
        data: caprail::instruction::CreateCompany { args }.data(),
    }
}

fn accounts(admin: &Pubkey, company: &Pubkey) -> Vec<(Pubkey, Account)> {
    vec![(*admin, funded_wallet()), empty(*company), system_program()]
}

fn create(
    mollusk: &Mollusk,
    admin: &Pubkey,
    args: CreateCompanyArgs,
) -> (Pubkey, InstructionResult) {
    let (company, _) = Company::find_address(args.company_id);
    let result = mollusk.process_instruction(
        &instruction(admin, &company, args),
        &accounts(admin, &company),
    );
    (company, result)
}

#[test]
fn creates_the_company_pda_and_emits_the_event() {
    let mollusk = mollusk();
    let admin = Pubkey::new_unique();
    let officer = Pubkey::new_unique();

    let (company, result) = create(&mollusk, &admin, args("Acme Robotics", officer));
    assert!(is_success(&result), "{:?}", result.program_result);

    let account = account_of(&result, &company);
    assert_eq!(account.owner, caprail::ID);
    assert_eq!(account.data.len(), Company::SPACE);

    let state: Company = read(&result, &company);
    assert_eq!(state.company_id, COMPANY_ID);
    assert_eq!(state.admin, admin);
    assert_eq!(state.compliance_officer, officer);
    assert_eq!(state.name_str(), "Acme Robotics");
    assert_eq!(state.token_count, 0);
    assert_eq!(state.bump, Company::find_address(COMPANY_ID).1);

    // Індекс дізнається про компанію лише з цієї події — тому вона несе все.
    let emitted = events::<CompanyCreated>(&take_logs(&mollusk));
    assert_eq!(emitted.len(), 1);
    let event = &emitted[0];
    assert_eq!(event.company, company);
    assert_eq!(event.company_id, COMPANY_ID);
    assert_eq!(event.admin, admin);
    assert_eq!(event.compliance_officer, officer);
    assert_eq!(event.name, "Acme Robotics");
}

/// Ім'я рівно на 32 байти має вміститись без обрізання — межа включна.
#[test]
fn keeps_a_name_of_exactly_32_bytes() {
    let mollusk = mollusk();
    let admin = Pubkey::new_unique();
    let name = "x".repeat(Company::NAME_LEN);

    let (company, result) = create(&mollusk, &admin, args(&name, Pubkey::new_unique()));
    assert!(is_success(&result), "{:?}", result.program_result);
    assert_eq!(read::<Company>(&result, &company).name_str(), name);
}

#[test]
fn rejects_an_empty_name_and_a_name_over_32_bytes() {
    let mollusk = mollusk();
    let admin = Pubkey::new_unique();
    let too_long = "x".repeat(Company::NAME_LEN + 1);

    for name in ["", too_long.as_str()] {
        let (company, result) = create(&mollusk, &admin, args(name, Pubkey::new_unique()));
        assert_eq!(
            custom_error_code(&result),
            Some(expected(CaprailError::InvalidName)),
            "{name:?}: {:?}",
            result.program_result
        );
        assert!(account_of(&result, &company).data.is_empty());
    }
}

/// FR-004: одна особа може мати обидві ролі, але двома ключами.
#[test]
fn rejects_the_admin_key_as_compliance_officer_and_the_zero_key() {
    let mollusk = mollusk();
    let admin = Pubkey::new_unique();

    for officer in [admin, Pubkey::default()] {
        let (_, result) = create(&mollusk, &admin, args("Acme", officer));
        assert_eq!(
            custom_error_code(&result),
            Some(expected(CaprailError::InvalidRoles)),
            "{officer}: {:?}",
            result.program_result
        );
    }
}

/// PDA для іншого `company_id` — інша адреса (FR-018): підсунути акаунт чужої
/// компанії неможливо, seeds ловить Anchor до хендлера.
#[test]
fn rejects_a_pda_derived_from_another_company_id() {
    let mollusk = mollusk();
    let admin = Pubkey::new_unique();
    let (other, _) = Company::find_address(COMPANY_ID + 1);

    let result = mollusk.process_instruction(
        &instruction(&admin, &other, args("Acme", Pubkey::new_unique())),
        &accounts(&admin, &other),
    );
    assert_eq!(
        custom_error_code(&result),
        Some(anchor_code(ErrorCode::ConstraintSeeds)),
        "{:?}",
        result.program_result
    );
}

#[test]
fn requires_the_admin_signature() {
    let mollusk = mollusk();
    let admin = Pubkey::new_unique();
    let (company, _) = Company::find_address(COMPANY_ID);
    let mut instruction = instruction(&admin, &company, args("Acme", Pubkey::new_unique()));
    instruction.accounts[0].is_signer = false;

    let result = mollusk.process_instruction(&instruction, &accounts(&admin, &company));
    assert_eq!(
        custom_error_code(&result),
        Some(anchor_code(ErrorCode::AccountNotSigner)),
        "{:?}",
        result.program_result
    );
}

/// Зайнятий `company_id` — відмова `init`, а не перезапис чужої компанії
/// іншим адміністратором.
#[test]
fn refuses_to_recreate_an_existing_company() {
    let mollusk = mollusk();
    let first_admin = Pubkey::new_unique();
    let second_admin = Pubkey::new_unique();
    let (company, _) = Company::find_address(COMPANY_ID);

    let mut accounts = accounts(&first_admin, &company);
    accounts.push((second_admin, funded_wallet()));
    let result = mollusk.process_instruction_chain(
        &[
            instruction(&first_admin, &company, args("First", Pubkey::new_unique())),
            instruction(
                &second_admin,
                &company,
                args("Second", Pubkey::new_unique()),
            ),
        ],
        &accounts,
    );

    assert!(!is_success(&result), "друге створення мало впасти");
    let state: Company = read(&result, &company);
    assert_eq!(state.admin, first_admin);
    assert_eq!(state.name_str(), "First");
}

/// Розмір і seeds — контракт із `packages/chain` (T024) та індексом: зміна
/// розкладки має бути свідомою, а не побічним ефектом додавання поля.
#[test]
fn state_layouts_are_fixed_size() {
    use caprail::state::{InvestorRecord, TokenConfig};
    assert_eq!(Company::SPACE, 8 + 8 + 32 + 32 + 32 + 4 + 1);
    assert_eq!(
        TokenConfig::SPACE,
        8 + 32 + 32 + 32 + (1 + 1 + 4) + 4 + 1 + 8 + 1
    );
    assert_eq!(
        InvestorRecord::SPACE,
        8 + 32 + 32 + 1 + 8 + 2 + 1 + 8 + 32 + 1
    );

    let mint = Pubkey::new_unique();
    let wallet = Pubkey::new_unique();
    assert_eq!(
        TokenConfig::find_address(&mint).0,
        Pubkey::find_program_address(&[b"token", mint.as_ref()], &caprail::ID).0
    );
    assert_eq!(
        InvestorRecord::find_address(&mint, &wallet).0,
        Pubkey::find_program_address(&[b"investor", mint.as_ref(), wallet.as_ref()], &caprail::ID)
            .0
    );
    assert_eq!(
        Company::find_address(7).0,
        Pubkey::find_program_address(&[b"company", &7u64.to_le_bytes()], &caprail::ID).0
    );
}
