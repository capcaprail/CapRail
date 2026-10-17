//! `create_grant` (T047): the grant record and its tokens leave the treasury
//! together, through the hook — the same path as `distribute`, so the
//! recipient's admission is checked by the rule itself, not by a copy of it.
//!
//! What the hook does with the grant afterwards (check 3, `Unvested`) is
//! proven in `hook_vesting.rs`.

mod common;

use anchor_lang::prelude::Pubkey;
use anchor_lang::{InstructionData, ToAccountMetas};
use anchor_spl::token_2022::spl_token_2022;
use caprail::events::{GrantCreated, TransferAllowed};
use caprail::hook::{extra_account_metas, EXTRA_ACCOUNT_COUNT, HOOK_PROGRAM_ID};
use caprail::instructions::CreateGrantArgs;
use caprail::state::{
    Company, Grant, InvestorRecord, InvestorStatus, TokenConfig, TransferPolicy, PERMIT_SEED,
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

const COMPANY_ID: u64 = 12;
const SUPPLY: u64 = 1_000_000;
const TOTAL: u64 = 48_000;
const YEAR: i64 = 365 * 24 * 60 * 60;

struct World {
    admin: Pubkey,
    officer: Pubkey,
    company: Pubkey,
    mint: Pubkey,
    token_config: Pubkey,
    treasury: Pubkey,
    list: Pubkey,
    recipient: Pubkey,
    recipient_ata: Pubkey,
    record: Pubkey,
    accounts: Vec<(Pubkey, Account)>,
}

fn world(mollusk: &Mollusk, registry: Option<(InvestorStatus, i64)>) -> World {
    let admin = Pubkey::new_unique();
    let officer = Pubkey::new_unique();
    let recipient = Pubkey::new_unique();
    let (company, company_bump) = Company::find_address(COMPANY_ID);
    let (mint, _) = TokenConfig::find_mint_address(&company, 0);
    let (token_config, config_bump) = TokenConfig::find_address(&mint);
    let treasury = ata(&company, &mint);
    let list = get_extra_account_metas_address(&mint, &HOOK_PROGRAM_ID);
    let recipient_ata = ata(&recipient, &mint);
    let (record, record_bump) = InvestorRecord::find_address(&mint, &recipient);

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
    let mut list_data =
        vec![0u8; ExtraAccountMetaList::size_of(EXTRA_ACCOUNT_COUNT).expect("list size")];
    ExtraAccountMetaList::init::<ExecuteInstruction>(
        &mut list_data,
        &extra_account_metas().expect("hook account list"),
    )
    .expect("list packs");

    let record_account = match registry {
        None => Account::default(),
        Some((status, expires_at)) => anchor_account(
            mollusk,
            &InvestorRecord {
                mint,
                wallet: recipient,
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
        recipient,
        recipient_ata,
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
            (recipient, funded_wallet()),
            empty(recipient_ata),
            (record, record_account),
            empty(Grant::find_address(&mint, &recipient).0),
            empty(Grant::find_address(&mint, &company).0),
            empty(permit_of(&treasury)),
            caprail_program(),
            hook_program(),
            token_program(),
            ata_program(),
            system_program(),
        ],
    }
}

fn permit_of(source: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[PERMIT_SEED, source.as_ref()], &caprail::ID).0
}

/// Starts now, cliff in a year, fully vested in four.
fn schedule(mollusk: &Mollusk) -> CreateGrantArgs {
    let start = now(mollusk);
    CreateGrantArgs {
        total: TOTAL,
        start_at: start,
        cliff_at: start + YEAR,
        end_at: start + 4 * YEAR,
    }
}

fn instruction(world: &World, signer: &Pubkey, args: CreateGrantArgs) -> Instruction {
    Instruction {
        program_id: caprail::ID,
        accounts: caprail::accounts::CreateGrant {
            admin: *signer,
            company: world.company,
            token_config: world.token_config,
            mint: world.mint,
            treasury: world.treasury,
            recipient: world.recipient,
            recipient_token_account: world.recipient_ata,
            grant: Grant::find_address(&world.mint, &world.recipient).0,
            extra_account_meta_list: world.list,
            state_program: caprail::ID,
            investor_record: world.record,
            source_grant: Grant::find_address(&world.mint, &world.company).0,
            transfer_permit: permit_of(&world.treasury),
            hook_program: HOOK_PROGRAM_ID,
            token_program: spl_token_2022::ID,
            associated_token_program: anchor_spl::associated_token::ID,
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
        data: caprail::instruction::CreateGrant { args }.data(),
    }
}

fn run(mollusk: &Mollusk, world: &World, args: CreateGrantArgs) -> InstructionResult {
    mollusk.process_instruction(&instruction(world, &world.admin, args), &world.accounts)
}

fn admitted(mollusk: &Mollusk) -> World {
    world(
        mollusk,
        Some((InvestorStatus::Approved, now(mollusk) + YEAR)),
    )
}

fn grant_address(world: &World) -> Pubkey {
    Grant::find_address(&world.mint, &world.recipient).0
}

fn assert_nothing_moved(result: &InstructionResult, world: &World) {
    assert_eq!(token_amount(result, &world.treasury), SUPPLY);
    assert!(account_of(result, &grant_address(world)).data.is_empty());
}

/// Happy path: the grant records the schedule, the whole `total` is on the
/// recipient's account at once, and the journal sees the transfer from the
/// hook plus one `GrantCreated` that carries the schedule for the index.
#[test]
fn admin_creates_a_grant_and_the_total_leaves_the_treasury_through_the_hook() {
    let mollusk = mollusk();
    let world = admitted(&mollusk);
    let args = schedule(&mollusk);

    let result = run(&mollusk, &world, args.clone());
    assert!(is_success(&result), "{:?}", result.program_result);
    assert_eq!(token_amount(&result, &world.recipient_ata), TOTAL);
    assert_eq!(token_amount(&result, &world.treasury), SUPPLY - TOTAL);

    let grant: Grant = read(&result, &grant_address(&world));
    let (_, bump) = Grant::find_address(&world.mint, &world.recipient);
    assert_eq!(grant.mint, world.mint);
    assert_eq!(grant.wallet, world.recipient);
    assert_eq!(grant.total, TOTAL);
    assert_eq!(grant.start_at, args.start_at);
    assert_eq!(grant.cliff_at, args.cliff_at);
    assert_eq!(grant.end_at, args.end_at);
    assert_eq!(grant.bump, bump);
    assert_eq!(
        account_of(&result, &grant_address(&world)).owner,
        caprail::ID
    );

    let cu = result.compute_units_consumed;
    assert!(cu <= CU_LIMIT, "create_grant costs {cu} CU of {CU_LIMIT}");
    println!("create_grant with a new ATA: {cu} CU of {CU_LIMIT}");

    let logs = take_logs(&mollusk);
    let transfers = events::<TransferAllowed>(&logs);
    assert_eq!(transfers.len(), 1);
    assert!(transfers[0].from_treasury);
    assert_eq!(transfers[0].destination_owner, world.recipient);
    assert_eq!(transfers[0].amount, TOTAL);

    let created = events::<GrantCreated>(&logs);
    assert_eq!(created.len(), 1);
    let event = &created[0];
    assert_eq!(event.grant, grant_address(&world));
    assert_eq!(event.company, world.company);
    assert_eq!(event.mint, world.mint);
    assert_eq!(event.wallet, world.recipient);
    assert_eq!(event.total, TOTAL);
    assert_eq!(event.start_at, args.start_at);
    assert_eq!(event.cliff_at, args.cliff_at);
    assert_eq!(event.end_at, args.end_at);
    assert_eq!(event.created_at, now(&mollusk));
}

/// A holder who already has tokens (bought or distributed) gets the grant on
/// top of them; the existing account is reused.
#[test]
fn adds_the_grant_to_an_existing_token_account() {
    let mollusk = mollusk();
    let mut world = admitted(&mollusk);
    let existing = world
        .accounts
        .iter_mut()
        .find(|(key, _)| *key == world.recipient_ata)
        .expect("recipient account in the world");
    existing.1 = hook_token_account(&mollusk, &world.mint, &world.recipient, 300);

    let result = run(&mollusk, &world, schedule(&mollusk));
    assert!(is_success(&result), "{:?}", result.program_result);
    assert_eq!(token_amount(&result, &world.recipient_ata), 300 + TOTAL);
}

/// One grant per wallet: the second one fails on the existing PDA, and the
/// treasury does not pay twice.
#[test]
fn a_second_grant_to_the_same_wallet_fails() {
    let mollusk = mollusk();
    let mut world = admitted(&mollusk);
    let first = run(&mollusk, &world, schedule(&mollusk));
    assert!(is_success(&first), "{:?}", first.program_result);
    world.accounts = first.resulting_accounts.clone();

    let second = run(&mollusk, &world, schedule(&mollusk));
    assert!(!is_success(&second));
    assert_eq!(token_amount(&second, &world.treasury), SUPPLY - TOTAL);
    assert_eq!(token_amount(&second, &world.recipient_ata), TOTAL);
}

/// The admin grants; the compliance officer cannot (FR-004).
#[test]
fn the_compliance_officer_cannot_create_a_grant() {
    let mollusk = mollusk();
    let world = admitted(&mollusk);
    let result = mollusk.process_instruction(
        &instruction(&world, &world.officer, schedule(&mollusk)),
        &world.accounts,
    );
    assert_eq!(
        custom_error_code(&result),
        Some(expected(CaprailError::Unauthorized)),
        "{:?}",
        result.program_result
    );
    assert_nothing_moved(&result, &world);
}

/// A schedule `vested()` refuses is refused here, before anything moves:
/// the hook would otherwise hold a grant it cannot evaluate.
#[test]
fn rejects_a_schedule_that_is_not_one() {
    let mollusk = mollusk();
    let world = admitted(&mollusk);
    let base = schedule(&mollusk);
    let cases = [
        (
            "cliff before start",
            CreateGrantArgs {
                cliff_at: base.start_at - 1,
                ..base.clone()
            },
        ),
        (
            "cliff after end",
            CreateGrantArgs {
                cliff_at: base.end_at + 1,
                ..base.clone()
            },
        ),
        (
            "no duration",
            CreateGrantArgs {
                cliff_at: base.start_at,
                end_at: base.start_at,
                ..base.clone()
            },
        ),
    ];
    for (name, args) in cases {
        let result = run(&mollusk, &world, args);
        assert_eq!(
            custom_error_code(&result),
            Some(expected(CaprailError::InvalidGrant)),
            "{name}: {:?}",
            result.program_result
        );
        assert_nothing_moved(&result, &world);
    }
}

/// The edges of a valid schedule are accepted: cliff on `start` (no cliff)
/// and cliff on `end` (all or nothing), and a start in the past.
#[test]
fn accepts_the_edges_of_a_valid_schedule() {
    let mollusk = mollusk();
    let base = schedule(&mollusk);
    for args in [
        CreateGrantArgs {
            cliff_at: base.start_at,
            ..base.clone()
        },
        CreateGrantArgs {
            cliff_at: base.end_at,
            ..base.clone()
        },
        CreateGrantArgs {
            start_at: base.start_at - 2 * YEAR,
            cliff_at: base.start_at - YEAR,
            ..base.clone()
        },
    ] {
        let world = admitted(&mollusk);
        let result = run(&mollusk, &world, args.clone());
        assert!(is_success(&result), "{args:?}: {:?}", result.program_result);
    }
}

/// A zero grant is not a grant; the hook would otherwise journal a transfer
/// that did not happen.
#[test]
fn rejects_a_zero_total() {
    let mollusk = mollusk();
    let world = admitted(&mollusk);
    let result = run(
        &mollusk,
        &world,
        CreateGrantArgs {
            total: 0,
            ..schedule(&mollusk)
        },
    );
    assert_eq!(
        custom_error_code(&result),
        Some(expected(CaprailError::InvalidAmount)),
        "{:?}",
        result.program_result
    );
    assert_nothing_moved(&result, &world);
}

/// The hook reads the grant of the sender's owner, and the treasury's owner
/// is the company: a grant to it would lock the treasury itself. The company's
/// ATA *is* the treasury, so Anchor refuses the call as the same mutable
/// account passed twice — before the handler, which is why it has no check.
#[test]
fn rejects_a_grant_to_the_treasury_owner() {
    let mollusk = mollusk();
    let mut world = admitted(&mollusk);
    world.recipient = world.company;
    world.recipient_ata = world.treasury;

    let result = run(&mollusk, &world, schedule(&mollusk));
    assert_eq!(
        custom_error_code(&result),
        Some(anchor_code(
            anchor_lang::error::ErrorCode::ConstraintDuplicateMutableAccount
        )),
        "{:?}",
        result.program_result
    );
    assert_nothing_moved(&result, &world);
}

/// An unadmitted recipient is refused by the hook with the same reason as
/// for any other transfer — and the grant record is not left behind.
#[test]
fn the_hook_rejects_a_grant_to_an_unadmitted_recipient() {
    let mollusk = mollusk();
    for registry in [
        None,
        Some((InvestorStatus::Revoked, GENESIS_UNIX_TS + YEAR)),
    ] {
        let world = world(&mollusk, registry);
        let result = run(&mollusk, &world, schedule(&mollusk));
        assert_eq!(
            custom_error_code(&result),
            Some(expected(CaprailError::NotAccredited)),
            "{registry:?}: {:?}",
            result.program_result
        );
        assert_nothing_moved(&result, &world);
        assert!(events::<GrantCreated>(&take_logs(&mollusk)).is_empty());
    }
}

/// More than the treasury holds — Token-2022 refuses, nothing is left half done.
#[test]
fn cannot_grant_more_than_the_treasury_holds() {
    let mollusk = mollusk();
    let world = admitted(&mollusk);
    let result = run(
        &mollusk,
        &world,
        CreateGrantArgs {
            total: SUPPLY + 1,
            ..schedule(&mollusk)
        },
    );
    assert!(!is_success(&result));
    assert_nothing_moved(&result, &world);
}
