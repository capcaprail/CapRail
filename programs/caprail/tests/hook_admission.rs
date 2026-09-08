//! Хук `execute` (T021): перевірки 1–2 і перші вимірювані критерії.
//!
//! Кожен переказ тут — **справжній** `transfer_checked` Token-2022 із хвостом
//! акаунтів, як його збере клієнт після резолюції списку. Хук викликає
//! токен-програма, а не тест: інакше «переказ відхилено» доводило б лише, що
//! наша функція вміє повертати помилку.
//!
//! SC-001 і SC-002 — набори по 100 гаманців. У стенді немає випадковості, тож
//! будь-який промах — помилка в правилі, а не «один із ста»; бюджет SC-002
//! (≥ 99) лишається як межа, нижче якої тест не має права бути зеленим.

mod common;

use anchor_lang::prelude::Pubkey;
use anchor_lang::{Discriminator, InstructionData, ToAccountMetas};
use caprail::events::TransferAllowed;
use caprail::hook::{extra_account_metas, EXECUTE_DISCRIMINATOR, EXTRA_ACCOUNT_COUNT};
use caprail::state::{
    Company, InvestorRecord, InvestorStatus, TokenConfig, TransferPolicy, GRANT_SEED, PERMIT_SEED,
};
use caprail::CaprailError;
use common::*;
use mollusk_svm::result::InstructionResult;
use mollusk_svm::Mollusk;
use solana_account::Account;
use solana_instruction::{AccountMeta, Instruction};
use spl_discriminator::SplDiscriminate;
use spl_tlv_account_resolution::state::ExtraAccountMetaList;
use spl_transfer_hook_interface::get_extra_account_metas_address;
use spl_transfer_hook_interface::instruction::ExecuteInstruction;

const COMPANY_ID: u64 = 7;
const SUPPLY: u64 = 1_000_000;
const AMOUNT: u64 = 10;
const YEAR: i64 = 365 * 24 * 60 * 60;
const SAMPLE: usize = 100;

fn accreditation_policy(require_accreditation: bool) -> TransferPolicy {
    TransferPolicy {
        require_accreditation,
        require_rofr: false,
        rofr_window_secs: 0,
    }
}

// ── Стан «токен випущено» ────────────────────────────────────────────────────

/// Те, що лишає після себе `create_token`: мінт із хуком, `TokenConfig`,
/// список акаунтів хука, казначейство під `Company`. Компанія — теж акаунт,
/// бо в переказі з казначейства вона стоїть підписантом.
struct Token {
    company: Pubkey,
    mint: Pubkey,
    token_config: Pubkey,
    list: Pubkey,
    accounts: Vec<(Pubkey, Account)>,
}

fn token(mollusk: &Mollusk, policy: TransferPolicy) -> Token {
    let (company, company_bump) = Company::find_address(COMPANY_ID);
    let (mint, _) = TokenConfig::find_mint_address(&company, 0);
    let (token_config, config_bump) = TokenConfig::find_address(&mint);
    let list = get_extra_account_metas_address(&mint, &caprail::ID);

    let company_state = Company {
        company_id: COMPANY_ID,
        admin: Pubkey::new_unique(),
        compliance_officer: Pubkey::new_unique(),
        name: [b'x'; Company::NAME_LEN],
        token_count: 1,
        bump: company_bump,
    };
    let config_state = TokenConfig {
        company,
        mint,
        treasury_owner: company,
        policy,
        policy_version: 3,
        decimals: DECIMALS,
        total_supply: SUPPLY,
        bump: config_bump,
    };
    // Список — той самий, що записує `create_token` (тест T018 тримає їх
    // рівними байт у байт).
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

    Token {
        company,
        mint,
        token_config,
        list,
        accounts: vec![
            (mint, hook_mint(mollusk, &company, SUPPLY, DECIMALS)),
            (token_config, anchor_account(mollusk, &config_state)),
            (list, rent_exempt(mollusk, list_data, caprail::ID)),
            (company, anchor_account(mollusk, &company_state)),
            caprail_program(),
        ],
    }
}

/// Запис реєстру одержувача або його відсутність — той стан, який хук
/// застане в мережі.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Registry {
    NoRecord,
    Record(InvestorStatus, i64),
}

impl Registry {
    fn approved_until(expires_at: i64) -> Self {
        Self::Record(InvestorStatus::Approved, expires_at)
    }

    fn account(self, mollusk: &Mollusk, token: &Token, wallet: &Pubkey) -> (Pubkey, Account) {
        let (record, bump) = InvestorRecord::find_address(&token.mint, wallet);
        match self {
            Self::NoRecord => empty(record),
            Self::Record(status, expires_at) => (
                record,
                anchor_account(
                    mollusk,
                    &InvestorRecord {
                        mint: token.mint,
                        wallet: *wallet,
                        status,
                        expires_at,
                        jurisdiction: *b"UA",
                        investor_type: 1,
                        updated_at: GENESIS_UNIX_TS,
                        updated_by: Pubkey::new_unique(),
                        bump,
                    },
                ),
            ),
        }
    }
}

// ── Переказ ──────────────────────────────────────────────────────────────────

/// Один `transfer_checked` разом з усіма акаунтами, які треба покласти в
/// транзакцію: базові чотири, список, наш хвіст і сама програма — так само,
/// як їх додає `addExtraAccountMetasForExecute` у клієнті.
struct Transfer {
    source: Pubkey,
    destination: Pubkey,
    instruction: Instruction,
    accounts: Vec<(Pubkey, Account)>,
}

fn transfer(
    mollusk: &Mollusk,
    token: &Token,
    sender: &Pubkey,
    recipient: &Pubkey,
    registry: Registry,
    amount: u64,
) -> Transfer {
    let source = ata(sender, &token.mint);
    let destination = ata(recipient, &token.mint);
    let (record, record_account) = registry.account(mollusk, token, recipient);
    let (grant, _) = Pubkey::find_program_address(
        &[GRANT_SEED, token.mint.as_ref(), sender.as_ref()],
        &caprail::ID,
    );
    let (permit, _) = Pubkey::find_program_address(&[PERMIT_SEED, source.as_ref()], &caprail::ID);

    let tail = [
        token.token_config,
        record,
        grant,
        permit,
        token.list,
        caprail::ID,
    ]
    .map(|key| AccountMeta::new_readonly(key, false));

    let mut accounts = token.accounts.clone();
    accounts.extend([
        (
            source,
            hook_token_account(mollusk, &token.mint, sender, SUPPLY),
        ),
        (
            destination,
            hook_token_account(mollusk, &token.mint, recipient, 0),
        ),
        (record, record_account),
        empty(grant),
        empty(permit),
    ]);
    // Казначейство підписує як PDA (у мережі — через `distribute`, T022);
    // стенд підписів не перевіряє, і компанія вже серед акаунтів.
    if *sender != token.company {
        accounts.push((*sender, funded_wallet()));
    }

    Transfer {
        source,
        destination,
        instruction: transfer_checked(
            &token.mint,
            &source,
            &destination,
            sender,
            amount,
            DECIMALS,
            &tail,
        ),
        accounts,
    }
}

fn run(mollusk: &Mollusk, transfer: &Transfer) -> InstructionResult {
    mollusk.process_instruction(&transfer.instruction, &transfer.accounts)
}

/// Дозволені перекази цієї спроби — з логів, накопичених від попереднього виклику.
fn allowed(mollusk: &Mollusk) -> Vec<TransferAllowed> {
    events::<TransferAllowed>(&take_logs(mollusk))
}

fn assert_moved(result: &InstructionResult, transfer: &Transfer, amount: u64) {
    assert!(is_success(result), "{:?}", result.program_result);
    assert_eq!(token_amount(result, &transfer.source), SUPPLY - amount);
    assert_eq!(token_amount(result, &transfer.destination), amount);
}

/// Відмова атомарна (FR-005): жодного часткового стану, баланси як до спроби.
fn assert_rejected(result: &InstructionResult, transfer: &Transfer, reason: CaprailError) {
    assert_eq!(
        custom_error_code(result),
        Some(expected(reason)),
        "{:?}",
        result.program_result
    );
    assert_eq!(token_amount(result, &transfer.source), SUPPLY);
    assert_eq!(token_amount(result, &transfer.destination), 0);
}

// ── SC-001 / SC-002 ──────────────────────────────────────────────────────────

/// SC-001: 100 недопущених гаманців → 100 відмов, баланси без змін. Чотири
/// види «недопущений» по 25: запису немає, статус `None`, `Revoked`, і
/// `Approved` з простроченим допуском — у кожного своя названа причина.
#[test]
fn sc_001_every_unadmitted_recipient_is_rejected_with_balances_intact() {
    let mollusk = mollusk();
    let token = token(&mollusk, accreditation_policy(true));
    let sender = Pubkey::new_unique();
    let now = now(&mollusk);

    let kinds = [
        (Registry::NoRecord, CaprailError::NotAccredited),
        (
            Registry::Record(InvestorStatus::None, now + YEAR),
            CaprailError::NotAccredited,
        ),
        (
            Registry::Record(InvestorStatus::Revoked, now + YEAR),
            CaprailError::NotAccredited,
        ),
        (
            Registry::approved_until(now - 1),
            CaprailError::AccreditationExpired,
        ),
    ];

    let mut rejected = 0;
    for i in 0..SAMPLE {
        let (registry, reason) = kinds[i % kinds.len()];
        let recipient = Pubkey::new_unique();
        let attempt = transfer(&mollusk, &token, &sender, &recipient, registry, AMOUNT);
        let result = run(&mollusk, &attempt);
        assert_rejected(&result, &attempt, reason);
        assert!(
            allowed(&mollusk).is_empty(),
            "відхилений переказ не має потрапляти в журнал успішних"
        );
        rejected += 1;
    }

    assert_eq!(rejected, SAMPLE);
    println!("SC-001: відхилено {rejected} із {SAMPLE}, баланси без змін");
}

/// SC-002: 100 допущених гаманців → проходять із першої спроби. Строки допуску
/// різні (від секунди до року), і кожен дозволений переказ лишає в логах рівно
/// одну подію `TransferAllowed` з обома сторонами.
#[test]
fn sc_002_every_admitted_recipient_passes_on_the_first_attempt() {
    let mollusk = mollusk();
    let token = token(&mollusk, accreditation_policy(true));
    let sender = Pubkey::new_unique();
    let now = now(&mollusk);

    let mut passed = 0;
    let mut peak_cu = 0;
    for i in 0..SAMPLE {
        let recipient = Pubkey::new_unique();
        let expires_at = now + 1 + (i as i64) * (YEAR / SAMPLE as i64);
        let attempt = transfer(
            &mollusk,
            &token,
            &sender,
            &recipient,
            Registry::approved_until(expires_at),
            AMOUNT,
        );
        let result = run(&mollusk, &attempt);
        assert_moved(&result, &attempt, AMOUNT);

        let events = allowed(&mollusk);
        assert_eq!(events.len(), 1, "одна подія на один переказ");
        assert_eq!(events[0].destination_owner, recipient);
        assert_eq!(events[0].source_owner, sender);
        assert_eq!(events[0].amount, AMOUNT);

        peak_cu = peak_cu.max(result.compute_units_consumed);
        passed += 1;
    }

    // Бюджет SC-002 — 99 зі 100; у стенді без випадковості нижче 100 — це
    // помилка правила, і саме її має показати число вище.
    assert!(passed >= 99, "SC-002: пройшло {passed} із {SAMPLE}");
    assert_eq!(passed, SAMPLE);
    println!("SC-002: пройшло {passed} із {SAMPLE}; пік CU переказу з хуком — {peak_cu}");
}

// ── Перевірка 2: межі ────────────────────────────────────────────────────────

/// `expires_at > now` — строга нерівність: в останню секунду допуск уже не діє.
#[test]
fn accreditation_ends_exactly_at_expiry() {
    let mut mollusk = mollusk();
    let token = token(&mollusk, accreditation_policy(true));
    let sender = Pubkey::new_unique();
    let recipient = Pubkey::new_unique();
    let expires_at = now(&mollusk) + 60;
    let registry = Registry::approved_until(expires_at);

    let attempt = transfer(&mollusk, &token, &sender, &recipient, registry, AMOUNT);
    assert_moved(&run(&mollusk, &attempt), &attempt, AMOUNT);

    advance(&mut mollusk, 59);
    assert_moved(&run(&mollusk, &attempt), &attempt, AMOUNT);

    advance(&mut mollusk, 1);
    assert_rejected(
        &run(&mollusk, &attempt),
        &attempt,
        CaprailError::AccreditationExpired,
    );
}

/// Казначейство компанії допуску не має і не потребує: повернення частки й
/// викуп за ROFR ідуть без запису в реєстрі.
#[test]
fn transfer_to_the_treasury_skips_admission() {
    let mollusk = mollusk();
    let token = token(&mollusk, accreditation_policy(true));
    let investor = Pubkey::new_unique();

    let attempt = transfer(
        &mollusk,
        &token,
        &investor,
        &token.company,
        Registry::NoRecord,
        AMOUNT,
    );
    assert_moved(&run(&mollusk, &attempt), &attempt, AMOUNT);

    let events = allowed(&mollusk);
    assert_eq!(events.len(), 1);
    assert!(!events[0].from_treasury);
    assert_eq!(events[0].destination_owner, token.company);
}

/// Розподіл із казначейства — той самий шлях і та сама перевірка одержувача:
/// казначейство не може віддати частку недопущеному.
#[test]
fn transfer_from_the_treasury_still_checks_the_recipient() {
    let mollusk = mollusk();
    let token = token(&mollusk, accreditation_policy(true));
    let investor = Pubkey::new_unique();
    let expires_at = now(&mollusk) + YEAR;

    let rejected = transfer(
        &mollusk,
        &token,
        &token.company,
        &investor,
        Registry::NoRecord,
        AMOUNT,
    );
    assert_rejected(
        &run(&mollusk, &rejected),
        &rejected,
        CaprailError::NotAccredited,
    );

    let allowed_transfer = transfer(
        &mollusk,
        &token,
        &token.company,
        &investor,
        Registry::approved_until(expires_at),
        AMOUNT,
    );
    assert_moved(&run(&mollusk, &allowed_transfer), &allowed_transfer, AMOUNT);

    let events = allowed(&mollusk);
    assert_eq!(events.len(), 1);
    assert!(events[0].from_treasury, "джерело частки — розподіл");
    assert_eq!(events[0].source_owner, token.company);
}

/// Політика без вимоги допуску — токен, який ходить вільно; хук усе одно
/// виконується і пише подію, бо журнал веде він.
#[test]
fn policy_without_accreditation_lets_anyone_receive() {
    let mollusk = mollusk();
    let token = token(&mollusk, accreditation_policy(false));
    let sender = Pubkey::new_unique();
    let recipient = Pubkey::new_unique();

    let attempt = transfer(
        &mollusk,
        &token,
        &sender,
        &recipient,
        Registry::NoRecord,
        AMOUNT,
    );
    assert_moved(&run(&mollusk, &attempt), &attempt, AMOUNT);
    assert_eq!(allowed(&mollusk).len(), 1);
}

/// Подія несе все, що потрібно рядку журналу й cap table, — worker акаунтів
/// транзакції не читає.
#[test]
fn transfer_allowed_carries_everything_the_indexer_needs() {
    let mollusk = mollusk();
    let token = token(&mollusk, accreditation_policy(true));
    let sender = Pubkey::new_unique();
    let recipient = Pubkey::new_unique();
    let expires_at = now(&mollusk) + YEAR;

    let attempt = transfer(
        &mollusk,
        &token,
        &sender,
        &recipient,
        Registry::approved_until(expires_at),
        AMOUNT,
    );
    assert_moved(&run(&mollusk, &attempt), &attempt, AMOUNT);

    let events = allowed(&mollusk);
    assert_eq!(events.len(), 1);
    let event = &events[0];
    assert_eq!(event.company, token.company);
    assert_eq!(event.mint, token.mint);
    assert_eq!(event.source, attempt.source);
    assert_eq!(event.destination, attempt.destination);
    assert_eq!(event.source_owner, sender);
    assert_eq!(event.destination_owner, recipient);
    assert_eq!(event.amount, AMOUNT);
    assert!(!event.from_treasury);
    assert_eq!(event.policy_version, 3);
}

// ── Перевірка 1 і межа з токен-програмою ─────────────────────────────────────

/// Виклик `execute` напряму (не з переказу) — прапорець `transferring` не
/// стоїть, і хук відповідає `NotTransferring`. Без цього прямий виклик писав би
/// в журнал переказ, якого не було.
#[test]
fn direct_call_outside_a_transfer_is_rejected() {
    let mollusk = mollusk();
    let token = token(&mollusk, accreditation_policy(true));
    let sender = Pubkey::new_unique();
    let recipient = Pubkey::new_unique();
    let expires_at = now(&mollusk) + YEAR;
    let attempt = transfer(
        &mollusk,
        &token,
        &sender,
        &recipient,
        Registry::approved_until(expires_at),
        AMOUNT,
    );

    let result = mollusk.process_instruction(
        &execute_directly(&token, &attempt, &sender, &recipient, &token.token_config),
        &attempt.accounts,
    );
    assert_eq!(
        custom_error_code(&result),
        Some(expected(CaprailError::NotTransferring)),
        "{:?}",
        result.program_result
    );
    assert!(allowed(&mollusk).is_empty());
}

/// Перевірка 1, перша половина: `TokenConfig` іншого мінта названий своєю
/// причиною. Через токен-програму такий акаунт не приїде (вона звіряє хвіст зі
/// списком), тож доводиться прямим викликом — і причина йде раніше за
/// `NotTransferring`.
#[test]
fn token_config_of_another_mint_is_named() {
    let mollusk = mollusk();
    let token = token(&mollusk, accreditation_policy(true));
    let sender = Pubkey::new_unique();
    let recipient = Pubkey::new_unique();
    let attempt = transfer(
        &mollusk,
        &token,
        &sender,
        &recipient,
        Registry::NoRecord,
        AMOUNT,
    );

    let (other_mint, _) = TokenConfig::find_mint_address(&token.company, 1);
    let (other_config, bump) = TokenConfig::find_address(&other_mint);
    let mut accounts = attempt.accounts.clone();
    accounts.push((
        other_config,
        anchor_account(
            &mollusk,
            &TokenConfig {
                company: token.company,
                mint: other_mint,
                treasury_owner: token.company,
                policy: accreditation_policy(true),
                policy_version: 1,
                decimals: DECIMALS,
                total_supply: SUPPLY,
                bump,
            },
        ),
    ));

    let result = mollusk.process_instruction(
        &execute_directly(&token, &attempt, &sender, &recipient, &other_config),
        &accounts,
    );
    assert_eq!(
        custom_error_code(&result),
        Some(expected(CaprailError::TokenConfigMismatch)),
        "{:?}",
        result.program_result
    );
}

/// Межа з токен-програмою: запис ЧУЖОГО гаманця (хай і `Approved`) на місці
/// запису одержувача відкидає сама Token-2022 — до нашого коду переказ не
/// доходить, і причина не наша.
#[test]
fn a_record_of_another_wallet_is_refused_by_the_token_program() {
    let mollusk = mollusk();
    let token = token(&mollusk, accreditation_policy(true));
    let sender = Pubkey::new_unique();
    let recipient = Pubkey::new_unique();
    let admitted_stranger = Pubkey::new_unique();
    let expires_at = now(&mollusk) + YEAR;

    let mut attempt = transfer(
        &mollusk,
        &token,
        &sender,
        &recipient,
        Registry::NoRecord,
        AMOUNT,
    );
    let (stranger_record, stranger_account) =
        Registry::approved_until(expires_at).account(&mollusk, &token, &admitted_stranger);
    let (own_record, _) = InvestorRecord::find_address(&token.mint, &recipient);
    for meta in &mut attempt.instruction.accounts {
        if meta.pubkey == own_record {
            meta.pubkey = stranger_record;
        }
    }
    attempt.accounts.push((stranger_record, stranger_account));

    let result = run(&mollusk, &attempt);
    assert!(!is_success(&result));
    let code = custom_error_code(&result);
    assert_ne!(code, Some(expected(CaprailError::NotAccredited)));
    assert_ne!(code, Some(expected(CaprailError::AccreditationExpired)));
    assert_eq!(token_amount(&result, &attempt.source), SUPPLY);
    assert!(allowed(&mollusk).is_empty());
}

/// Дискримінатор `execute` — той, що кладе Token-2022 в дані CPI. Anchor-івський
/// sighash тут означав би, що хук ніколи не викликається.
#[test]
fn execute_discriminator_is_the_interface_one() {
    assert_eq!(
        caprail::instruction::Execute::DISCRIMINATOR,
        ExecuteInstruction::SPL_DISCRIMINATOR_SLICE
    );
    assert_eq!(
        EXECUTE_DISCRIMINATOR,
        ExecuteInstruction::SPL_DISCRIMINATOR_SLICE
    );
    // Ті самі байти, що в даних інструкції інтерфейсу: далі йде лише `amount`.
    let key = Pubkey::new_unique();
    let interface = spl_transfer_hook_interface::instruction::execute(
        &caprail::ID,
        &key,
        &key,
        &key,
        &key,
        AMOUNT,
    );
    assert_eq!(
        interface.data,
        caprail::instruction::Execute { amount: AMOUNT }.data()
    );
}

/// `execute` як окрема інструкція — з тими самими акаунтами, що резолвить
/// токен-програма, але без переказу довкола.
fn execute_directly(
    token: &Token,
    attempt: &Transfer,
    sender: &Pubkey,
    recipient: &Pubkey,
    token_config: &Pubkey,
) -> Instruction {
    let (record, _) = InvestorRecord::find_address(&token.mint, recipient);
    let (grant, _) = Pubkey::find_program_address(
        &[GRANT_SEED, token.mint.as_ref(), sender.as_ref()],
        &caprail::ID,
    );
    let (permit, _) =
        Pubkey::find_program_address(&[PERMIT_SEED, attempt.source.as_ref()], &caprail::ID);
    Instruction {
        program_id: caprail::ID,
        accounts: caprail::accounts::Execute {
            source: attempt.source,
            mint: token.mint,
            destination: attempt.destination,
            owner: *sender,
            extra_account_meta_list: token.list,
            token_config: *token_config,
            investor_record: record,
            grant,
            transfer_permit: permit,
        }
        .to_account_metas(None),
        data: caprail::instruction::Execute { amount: AMOUNT }.data(),
    }
}
