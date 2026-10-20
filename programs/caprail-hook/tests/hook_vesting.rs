//! Hook check 3 (US3): the unvested part of a grant stays on the sender's
//! account, tokens bought on the market do not.
//!
//! Every transfer is a real Token-2022 `transfer_checked` with the hook tail,
//! as in `hook_admission.rs`: the grant is found by the token program from the
//! source account's owner, not handed to the hook by the test.

#[path = "../../caprail/tests/common/mod.rs"]
mod common;
mod stand;

use anchor_lang::prelude::Pubkey;
use caprail::state::{Grant, GRANT_SEED};
use caprail::CaprailError;
use common::*;
use mollusk_svm::result::InstructionResult;
use mollusk_svm::Mollusk;
use solana_instruction::AccountMeta;
use stand::*;

const TOTAL: u64 = 1_000;

struct Schedule {
    start_at: i64,
    cliff_at: i64,
    end_at: i64,
}

/// 100 seconds long, 40 of them already past: 400 of 1 000 vested now.
fn forty_percent(now: i64) -> Schedule {
    Schedule {
        start_at: now - 40,
        cliff_at: now - 20,
        end_at: now + 60,
    }
}

fn before_cliff(now: i64) -> Schedule {
    Schedule {
        start_at: now - 10,
        cliff_at: now + 10,
        end_at: now + 90,
    }
}

/// A transfer from a wallet that holds `balance` and has a grant of `TOTAL`
/// on `schedule`, to an admitted recipient.
fn granted(
    mollusk: &Mollusk,
    token: &Token,
    schedule: &Schedule,
    balance: u64,
    amount: u64,
) -> (Transfer, Pubkey) {
    let admitted = Registry::approved_until(now(mollusk) + YEAR);
    granted_to(mollusk, token, schedule, admitted, balance, amount)
}

fn granted_to(
    mollusk: &Mollusk,
    token: &Token,
    schedule: &Schedule,
    registry: Registry,
    balance: u64,
    amount: u64,
) -> (Transfer, Pubkey) {
    let sender = Pubkey::new_unique();
    let recipient = Pubkey::new_unique();
    let mut attempt = transfer(mollusk, token, &sender, &recipient, registry, amount);

    let (grant, bump) = Pubkey::find_program_address(
        &[GRANT_SEED, token.mint.as_ref(), sender.as_ref()],
        &caprail::ID,
    );
    let state = Grant {
        mint: token.mint,
        wallet: sender,
        total: TOTAL,
        start_at: schedule.start_at,
        cliff_at: schedule.cliff_at,
        end_at: schedule.end_at,
        bump,
    };
    replace(&mut attempt, grant, anchor_account(mollusk, &state));
    let source = hook_token_account(mollusk, &token.mint, &sender, balance);
    let source_key = attempt.source;
    replace(&mut attempt, source_key, source);
    (attempt, sender)
}

fn replace(attempt: &mut Transfer, key: Pubkey, account: solana_account::Account) {
    let slot = attempt
        .accounts
        .iter_mut()
        .find(|(candidate, _)| *candidate == key)
        .expect("the stand puts every account of the transfer");
    slot.1 = account;
}

fn assert_moved(result: &InstructionResult, attempt: &Transfer, balance: u64, amount: u64) {
    assert!(is_success(result), "{:?}", result.program_result);
    assert_eq!(token_amount(result, &attempt.source), balance - amount);
    assert_eq!(token_amount(result, &attempt.destination), amount);
}

fn assert_unvested(
    mollusk: &Mollusk,
    result: &InstructionResult,
    attempt: &Transfer,
    balance: u64,
) {
    assert_rejected(mollusk, result, attempt, balance, CaprailError::Unvested);
}

fn assert_rejected(
    mollusk: &Mollusk,
    result: &InstructionResult,
    attempt: &Transfer,
    balance: u64,
    reason: CaprailError,
) {
    assert_eq!(
        custom_error_code(result),
        Some(expected(reason)),
        "{:?}",
        result.program_result
    );
    assert_eq!(token_amount(result, &attempt.source), balance);
    assert_eq!(token_amount(result, &attempt.destination), 0);
    assert!(allowed(mollusk).is_empty());
}

#[test]
fn before_the_cliff_not_a_single_unit_moves() {
    let mollusk = mollusk();
    let token = token(&mollusk, accreditation_policy(true));
    let (attempt, _) = granted(&mollusk, &token, &before_cliff(now(&mollusk)), TOTAL, 1);

    assert_unvested(&mollusk, &run(&mollusk, &attempt), &attempt, TOTAL);
}

#[test]
fn at_forty_percent_the_vested_part_moves_in_full() {
    let mollusk = mollusk();
    let token = token(&mollusk, accreditation_policy(true));
    let (attempt, sender) = granted(&mollusk, &token, &forty_percent(now(&mollusk)), TOTAL, 400);

    assert_moved(&run(&mollusk, &attempt), &attempt, TOTAL, 400);
    let events = allowed(&mollusk);
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].source_owner, sender);
    assert_eq!(events[0].amount, 400);
}

#[test]
fn at_forty_percent_one_unit_over_is_rejected() {
    let mollusk = mollusk();
    let token = token(&mollusk, accreditation_policy(true));
    let (attempt, _) = granted(&mollusk, &token, &forty_percent(now(&mollusk)), TOTAL, 401);

    assert_unvested(&mollusk, &run(&mollusk, &attempt), &attempt, TOTAL);
}

/// The lock is read against the network clock at the moment of the transfer,
/// not fixed when the grant was made: one second later, 10 more units vest.
#[test]
fn the_lock_follows_the_clock() {
    let mut mollusk = mollusk();
    let token = token(&mollusk, accreditation_policy(true));
    let (attempt, _) = granted(&mollusk, &token, &forty_percent(now(&mollusk)), TOTAL, 410);

    assert_unvested(&mollusk, &run(&mollusk, &attempt), &attempt, TOTAL);
    advance(&mut mollusk, 1);
    assert_moved(&run(&mollusk, &attempt), &attempt, TOTAL, 410);
}

#[test]
fn from_the_end_of_the_schedule_everything_moves() {
    let mut mollusk = mollusk();
    let token = token(&mollusk, accreditation_policy(true));
    let (attempt, _) = granted(
        &mollusk,
        &token,
        &forty_percent(now(&mollusk)),
        TOTAL,
        TOTAL,
    );

    advance(&mut mollusk, 60);
    assert_moved(&run(&mollusk, &attempt), &attempt, TOTAL, TOTAL);
}

/// US3, third acceptance: tokens bought on top of the grant are not locked —
/// the lock is `total − vested`, not a share of the balance.
#[test]
fn purchased_tokens_are_free_even_before_the_cliff() {
    let mollusk = mollusk();
    let token = token(&mollusk, accreditation_policy(true));
    let balance = TOTAL + 500;
    let schedule = before_cliff(now(&mollusk));

    let (free, _) = granted(&mollusk, &token, &schedule, balance, 500);
    assert_moved(&run(&mollusk, &free), &free, balance, 500);
    assert_eq!(allowed(&mollusk).len(), 1);

    let (over, _) = granted(&mollusk, &token, &schedule, balance, 501);
    assert_unvested(&mollusk, &run(&mollusk, &over), &over, balance);
}

/// The market path: the offer PDA signs as a delegate, not the seller. The
/// grant is still the seller's, because the token program finds it by the
/// source account's owner, not by the signer.
#[test]
fn a_delegated_transfer_is_locked_by_the_owners_grant() {
    let mollusk = mollusk();
    let token = token(&mollusk, accreditation_policy(true));
    let (mut attempt, _) = granted(&mollusk, &token, &before_cliff(now(&mollusk)), TOTAL, 1);

    let delegate = Pubkey::new_unique();
    let source = attempt.source;
    let slot = attempt
        .accounts
        .iter_mut()
        .find(|(key, _)| *key == source)
        .expect("source account");
    set_delegate(&mut slot.1, &delegate, TOTAL);
    attempt.instruction.accounts[3] = AccountMeta::new_readonly(delegate, true);
    attempt.accounts.push((delegate, funded_wallet()));

    assert_unvested(&mollusk, &run(&mollusk, &attempt), &attempt, TOTAL);
}

/// Vesting is a property of the grant, not of the admission policy: a token
/// that admits anyone still keeps the unvested part in place.
#[test]
fn the_lock_holds_without_an_accreditation_policy() {
    let mollusk = mollusk();
    let token = token(&mollusk, accreditation_policy(false));
    let (attempt, _) = granted(&mollusk, &token, &before_cliff(now(&mollusk)), TOTAL, 1);

    assert_unvested(&mollusk, &run(&mollusk, &attempt), &attempt, TOTAL);
}

/// Checks run in the order of `PLAN.md`: a transfer that fails both
/// admission and vesting is named by admission.
#[test]
fn admission_is_checked_before_vesting() {
    let mollusk = mollusk();
    let token = token(&mollusk, accreditation_policy(true));
    let schedule = before_cliff(now(&mollusk));
    let (attempt, _) = granted_to(&mollusk, &token, &schedule, Registry::NoRecord, TOTAL, 1);

    assert_rejected(
        &mollusk,
        &run(&mollusk, &attempt),
        &attempt,
        TOTAL,
        CaprailError::NotAccredited,
    );
}
