//! CU-гейт хука (T023) і оцінка SC-010.
//!
//! Живе в `cargo test`, а не в `cargo bench`: бенч у CI не запускають, і
//! стеля, покладена туди, перевіряється тоді, коли хтось згадає. Сам
//! `mollusk-svm-bencher` бюджету не знає — його `must_pass` панікує лише на
//! відмові інструкції, тож твердження про стелю тут наші, а бенчер лишає
//! таблицю з дельтою по імені випадку в `target/benches/compute_units.md`.
//!
//! Дві стелі, і обидві на тих самих переказах, що доводять правило
//! (`stand`): вся `transfer_checked` з резолюцією хвоста в Token-2022 — у
//! межах бюджету інструкції мережі; сам `execute` — у межах, які він не має
//! права перерости непомітно. Друга ловить регресію правила за десятки тисяч
//! CU до того, як перша щось помітить.

#[path = "../../caprail/tests/common/mod.rs"]
mod common;
mod stand;

use anchor_lang::prelude::Pubkey;
use caprail::hook::HOOK_PROGRAM_ID;
use caprail::state::InvestorStatus;
use caprail::CaprailError;
use common::*;
use mollusk_svm::Mollusk;
use mollusk_svm_bencher::MolluskComputeUnitBencher;
use stand::*;

/// Стеля на сам `execute`. Сьогодні він коштує ≈ 5,9 тис. на дозволеному і
/// ≤ 7 тис. на відмові; підняти цю межу можна лише свідомо, разом із новим
/// числом у SCRATCHPAD. Vesting і ROFR (US2–US3) додадуть читання `Grant`
/// і `TransferPermit` — по кілька сотень CU, не десятки тисяч.
const HOOK_CU_CEILING: u64 = 20_000;

/// SC-010: комплаєнтний переказ коштує відправнику ≤ 0,001 SOL.
const SC_010_LAMPORTS: u64 = 1_000_000;

const AMOUNT: u64 = 10;

/// Таблиця бенчера — поза git, як і решта артефактів збірки: правило репо
/// «`*.md` не комітяться» тут не порушується, а числом правди лишається запис
/// у SCRATCHPAD і таблиці M1.
const BENCH_DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../target/benches");

enum Outcome {
    Allowed,
    Rejected(CaprailError),
}

/// Один вимірюваний переказ. Ім'я — ключ дельти в таблиці бенчера, тому
/// змінювати його означає втратити історію випадку.
struct Case {
    name: &'static str,
    transfer: Transfer,
    outcome: Outcome,
}

/// Усі шляхи, якими переказ проходить через хук, плюс обидві відмови
/// перевірки 2. Відмови — теж у гейті: вони йдуть тим самим `execute`, і
/// сторонній гаманець платить за них так само.
fn cases(mollusk: &Mollusk) -> Vec<Case> {
    let now = now(mollusk);
    let admitted = Registry::approved_until(now + YEAR);
    let strict = token(mollusk, accreditation_policy(true));
    let open = token(mollusk, accreditation_policy(false));
    // Ключі фіксовані, а не `new_unique()`: гаманці входять у seeds PDA
    // реєстру, гранту й дозволу, а Token-2022 виводить їх `find_program_address`
    // — по 1 500 CU на кожну спробу bump. Лічильник `new_unique()` спільний
    // на процес, тож із паралельними тестами ключі гуляють між прогонами і
    // таблиця бенчера показувала б дельту ±6 000 без жодної зміни коду.
    let sender = Pubkey::new_from_array([0x51; 32]);
    let recipient = Pubkey::new_from_array([0x52; 32]);

    vec![
        Case {
            name: "transfer_wallet_to_wallet",
            transfer: transfer(mollusk, &strict, &sender, &recipient, admitted, AMOUNT),
            outcome: Outcome::Allowed,
        },
        Case {
            name: "transfer_from_treasury",
            transfer: transfer(
                mollusk,
                &strict,
                &strict.company,
                &recipient,
                admitted,
                AMOUNT,
            ),
            outcome: Outcome::Allowed,
        },
        Case {
            name: "transfer_to_treasury",
            transfer: transfer(
                mollusk,
                &strict,
                &sender,
                &strict.company,
                Registry::NoRecord,
                AMOUNT,
            ),
            outcome: Outcome::Allowed,
        },
        Case {
            name: "transfer_policy_open",
            transfer: transfer(
                mollusk,
                &open,
                &sender,
                &recipient,
                Registry::NoRecord,
                AMOUNT,
            ),
            outcome: Outcome::Allowed,
        },
        Case {
            name: "transfer_rejected_no_record",
            transfer: transfer(
                mollusk,
                &strict,
                &sender,
                &recipient,
                Registry::NoRecord,
                AMOUNT,
            ),
            outcome: Outcome::Rejected(CaprailError::NotAccredited),
        },
        Case {
            name: "transfer_rejected_revoked",
            transfer: transfer(
                mollusk,
                &strict,
                &sender,
                &recipient,
                Registry::Record(InvestorStatus::Revoked, now + YEAR),
                AMOUNT,
            ),
            outcome: Outcome::Rejected(CaprailError::NotAccredited),
        },
        Case {
            name: "transfer_rejected_expired",
            transfer: transfer(
                mollusk,
                &strict,
                &sender,
                &recipient,
                Registry::approved_until(now - 1),
                AMOUNT,
            ),
            outcome: Outcome::Rejected(CaprailError::AccreditationExpired),
        },
    ]
}

/// Кожен переказ через хук — у бюджеті інструкції, і сам хук — у своїй стелі.
/// Вимірювання вимагає названого результату: відмова на першому гарді
/// коштує кілька тисяч CU і вклалася б у будь-який бюджет, а дозволений
/// переказ, що «випадково» відхилився, дав би зелений гейт ні про що.
#[test]
fn every_transfer_through_the_hook_fits_the_budget() {
    let mollusk = mollusk();
    let cases = cases(&mollusk);
    let mut rows = Vec::with_capacity(cases.len());

    for case in &cases {
        let result = run(&mollusk, &case.transfer);
        match case.outcome {
            Outcome::Allowed => {
                assert!(
                    is_success(&result),
                    "{}: {:?}",
                    case.name,
                    result.program_result
                );
                assert_eq!(token_amount(&result, &case.transfer.destination), AMOUNT);
            }
            Outcome::Rejected(reason) => {
                assert_eq!(
                    custom_error_code(&result),
                    Some(expected(reason)),
                    "{}: {:?}",
                    case.name,
                    result.program_result
                );
            }
        }

        let total = result.compute_units_consumed;
        let hook = consumed_by(&take_logs(&mollusk), &HOOK_PROGRAM_ID)
            .unwrap_or_else(|| panic!("{}: хук не викликано", case.name));
        assert!(
            total <= CU_LIMIT,
            "{}: переказ коштує {total} CU при бюджеті інструкції {CU_LIMIT}",
            case.name
        );
        assert!(
            hook <= HOOK_CU_CEILING,
            "{}: хук коштує {hook} CU при стелі {HOOK_CU_CEILING}",
            case.name
        );
        rows.push((case.name, total, hook));
    }

    println!("| випадок | переказ, CU | хук, CU |");
    for (name, total, hook) in &rows {
        println!("| {name} | {total} | {hook} |");
    }
    let peak_total = rows.iter().map(|row| row.1).max().unwrap_or(0);
    let peak_hook = rows.iter().map(|row| row.2).max().unwrap_or(0);
    println!(
        "пік: переказ {peak_total} із {CU_LIMIT}, хук {peak_hook} із {HOOK_CU_CEILING} \
         (запас ×{:.1})",
        HOOK_CU_CEILING as f64 / peak_hook.max(1) as f64
    );

    // Таблиця з дельтою — після гейту, на тих самих інструкціях. `must_pass`
    // тут вимкнено свідомо: результат кожного випадку вже названо вище, а
    // відмови в таблиці потрібні — за них теж платять.
    let mut bencher = MolluskComputeUnitBencher::new(mollusk)
        .must_pass(false)
        .out_dir(BENCH_DIR);
    for case in &cases {
        bencher = bencher.bench((
            case.name,
            &case.transfer.instruction,
            &case.transfer.accounts,
        ));
    }
    bencher.execute();
}

/// SC-010: ціна комплаєнтного переказу для відправника. Хвіст хука підписів
/// не додає, тож переказ — один підпис і базова комісія; пріоритетна на
/// ~50 тис. CU — частки лампорта і в оцінку не входить. Рента рахунку
/// одержувача — окрема стаття: її платить той, хто рахунок створює
/// (`distribute` — адміністратор, інакше сам одержувач), і в межу 0,001 SOL
/// вона не вкладається — критерій тримається лише для існуючого рахунку.
#[test]
fn sc_010_a_compliant_transfer_costs_the_sender_one_base_fee() {
    let mollusk = mollusk();
    let token = token(&mollusk, accreditation_policy(true));
    let sender = Pubkey::new_unique();
    let recipient = Pubkey::new_unique();
    let attempt = transfer(
        &mollusk,
        &token,
        &sender,
        &recipient,
        Registry::approved_until(now(&mollusk) + YEAR),
        AMOUNT,
    );
    assert!(is_success(&run(&mollusk, &attempt)));

    let signatures = attempt
        .instruction
        .accounts
        .iter()
        .filter(|meta| meta.is_signer)
        .count() as u64;
    assert_eq!(signatures, 1, "переказ підписує лише відправник");
    let fee = signatures * LAMPORTS_PER_SIGNATURE;
    assert!(
        fee <= SC_010_LAMPORTS,
        "SC-010: {fee} lamports при межі {SC_010_LAMPORTS}"
    );

    let account_len = hook_token_account(&mollusk, &token.mint, &recipient, 0)
        .data
        .len();
    let rent = mollusk.sysvars.rent.minimum_balance(account_len);
    println!(
        "SC-010: переказ на існуючий рахунок — {fee} lamports ({} підпис); \
         рента рахунку одержувача ({account_len} Б) — {rent} lamports, платить той, хто створює",
        signatures
    );
}
