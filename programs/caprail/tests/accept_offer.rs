//! `accept_offer` (T037): угода — три перекази в одній інструкції.
//!
//! Доводиться, що частка йде продавець → покупець делегатом `Offer` PDA через
//! хук (журнал бачить її як `TransferAllowed`), оплата — покупець → продавець
//! за вирахуванням комісії, комісія — на рахунок платформи; що часткове
//! прийняття зменшує `remaining` і делегування рівно на куплене, а повне
//! переводить пропозицію в `Filled`; і що кожна відмова — хуком чи нами —
//! лишає всі баланси як були. Масові прогони SC-006/SC-007 — у `market.rs` (T038).

mod common;

use anchor_lang::error::ErrorCode;
use anchor_lang::prelude::Pubkey;
use anchor_lang::{InstructionData, ToAccountMetas};
use anchor_spl::token_2022::spl_token_2022;
use caprail::events::{OfferAccepted, TransferAllowed};
use caprail::hook::{extra_account_metas, EXTRA_ACCOUNT_COUNT, HOOK_PROGRAM_ID};
use caprail::state::{
    Company, InvestorRecord, InvestorStatus, Offer, OfferStatus, PlatformConfig, TokenConfig,
    TransferPolicy, GRANT_SEED, PERMIT_SEED,
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

const COMPANY_ID: u64 = 31;
const SUPPLY: u64 = 1_000_000;
const HELD: u64 = 10_000;
const OFFER_ID: u64 = 3;
const AMOUNT: u64 = 4_000;
// 1,25 одиниці стейблкоїна (6 знаків) за частку.
const PRICE: u64 = 1_250_000;
const PAYMENT_DECIMALS: u8 = 6;
const FEE_BPS: u16 = 100;
// Вистачає на всю пропозицію із запасом.
const BUYER_FUNDS: u64 = 10_000_000_000;
const YEAR: i64 = 365 * 24 * 60 * 60;

/// Компанія з токеном, платформа, продавець із відкритою пропозицією на
/// `AMOUNT` (делегування вже стоїть) і допущений покупець зі стейблкоїном.
/// Рахунків покупця під частки і продавця під оплату ще немає — інструкція
/// створює їх сама.
struct World {
    mollusk: Mollusk,
    seller: Pubkey,
    buyer: Pubkey,
    platform: Pubkey,
    token_config: Pubkey,
    mint: Pubkey,
    payment_mint: Pubkey,
    fee_treasury: Pubkey,
    seller_ata: Pubkey,
    buyer_ata: Pubkey,
    buyer_payment: Pubkey,
    seller_payment: Pubkey,
    list: Pubkey,
    record: Pubkey,
    accounts: Vec<(Pubkey, Account)>,
}

fn offer_state(world_mint: &Pubkey, seller: &Pubkey, remaining: u64, rofr_until: i64) -> Offer {
    Offer {
        mint: *world_mint,
        seller: *seller,
        offer_id: OFFER_ID,
        amount: AMOUNT,
        remaining,
        price_per_unit: PRICE,
        rofr_until,
        status: OfferStatus::Open,
        created_at: GENESIS_UNIX_TS,
        bump: Offer::find_address(world_mint, seller, OFFER_ID).1,
    }
}

fn world() -> World {
    let mollusk = mollusk();
    let seller = Pubkey::new_unique();
    let buyer = Pubkey::new_unique();
    let officer = Pubkey::new_unique();
    let platform_authority = Pubkey::new_unique();
    let (company, _) = Company::find_address(COMPANY_ID);
    let (mint, _) = TokenConfig::find_mint_address(&company, 0);
    let (token_config, config_bump) = TokenConfig::find_address(&mint);
    let (platform, platform_bump) = PlatformConfig::find_address();
    let (offer, _) = Offer::find_address(&mint, &seller, OFFER_ID);
    let payment_mint = Pubkey::new_unique();
    let fee_treasury = ata(&platform_authority, &payment_mint);
    let seller_ata = ata(&seller, &mint);
    let buyer_ata = ata(&buyer, &mint);
    let buyer_payment = ata(&buyer, &payment_mint);
    let seller_payment = ata(&seller, &payment_mint);
    let list = get_extra_account_metas_address(&mint, &HOOK_PROGRAM_ID);
    let (record, record_bump) = InvestorRecord::find_address(&mint, &buyer);

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
    let platform_state = PlatformConfig {
        authority: platform_authority,
        payment_mint,
        fee_treasury,
        fee_bps: FEE_BPS,
        bump: platform_bump,
    };
    let record_state = InvestorRecord {
        mint,
        wallet: buyer,
        status: InvestorStatus::Approved,
        expires_at: GENESIS_UNIX_TS + YEAR,
        jurisdiction: *b"UA",
        investor_type: 1,
        updated_at: GENESIS_UNIX_TS,
        updated_by: officer,
        bump: record_bump,
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

    // Стан, до якого доводить `create_offer`: частки в продавця, пропозиція —
    // делегат на `AMOUNT`.
    let mut seller_account = hook_token_account(&mollusk, &mint, &seller, HELD);
    set_delegate(&mut seller_account, &offer, AMOUNT);

    let accounts = vec![
        (buyer, funded_wallet()),
        (seller, funded_wallet()),
        (platform, anchor_account(&mollusk, &platform_state)),
        (
            offer,
            anchor_account(&mollusk, &offer_state(&mint, &seller, AMOUNT, 0)),
        ),
        (token_config, anchor_account(&mollusk, &config_state)),
        (mint, hook_mint(&mollusk, &company, SUPPLY, DECIMALS)),
        (seller_ata, seller_account),
        empty(buyer_ata),
        (
            payment_mint,
            plain_mint(&mollusk, &platform_authority, BUYER_FUNDS, PAYMENT_DECIMALS),
        ),
        (
            buyer_payment,
            plain_token_account(&mollusk, &payment_mint, &buyer, BUYER_FUNDS),
        ),
        empty(seller_payment),
        (
            fee_treasury,
            plain_token_account(&mollusk, &payment_mint, &platform_authority, 0),
        ),
        (list, rent_exempt(&mollusk, list_data, HOOK_PROGRAM_ID)),
        (record, anchor_account(&mollusk, &record_state)),
        empty(grant_of(&mint, &seller)),
        empty(permit_of(&seller_ata)),
        caprail_program(),
        hook_program(),
        token_program(),
        ata_program(),
        system_program(),
    ];
    World {
        mollusk,
        seller,
        buyer,
        platform,
        token_config,
        mint,
        payment_mint,
        fee_treasury,
        seller_ata,
        buyer_ata,
        buyer_payment,
        seller_payment,
        list,
        record,
        accounts,
    }
}

fn grant_of(mint: &Pubkey, sender: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[GRANT_SEED, mint.as_ref(), sender.as_ref()], &caprail::ID).0
}

fn permit_of(source: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[PERMIT_SEED, source.as_ref()], &caprail::ID).0
}

impl World {
    fn offer(&self) -> Pubkey {
        Offer::find_address(&self.mint, &self.seller, OFFER_ID).0
    }

    fn account_mut(&mut self, key: &Pubkey) -> &mut Account {
        &mut self
            .accounts
            .iter_mut()
            .find(|(k, _)| k == key)
            .expect("акаунт стенду")
            .1
    }

    fn set_offer(&mut self, offer: &Offer) {
        let account = anchor_account(&self.mollusk, offer);
        let key = self.offer();
        *self.account_mut(&key) = account;
    }

    /// Стан після інструкції стає стартовим для наступної — як у мережі.
    fn apply(&mut self, result: &InstructionResult) {
        for (key, account) in &result.resulting_accounts {
            if let Some(slot) = self.accounts.iter_mut().find(|(k, _)| k == key) {
                slot.1 = account.clone();
            }
        }
    }

    fn instruction(&self, buyer: &Pubkey, fee_treasury: &Pubkey, amount: u64) -> Instruction {
        Instruction {
            program_id: caprail::ID,
            accounts: caprail::accounts::AcceptOffer {
                buyer: *buyer,
                platform: self.platform,
                offer: self.offer(),
                seller: self.seller,
                token_config: self.token_config,
                mint: self.mint,
                seller_token_account: self.seller_ata,
                buyer_token_account: ata(buyer, &self.mint),
                payment_mint: self.payment_mint,
                buyer_payment_account: ata(buyer, &self.payment_mint),
                seller_payment_account: self.seller_payment,
                fee_treasury: *fee_treasury,
                extra_account_meta_list: self.list,
                state_program: caprail::ID,
                investor_record: InvestorRecord::find_address(&self.mint, buyer).0,
                grant: grant_of(&self.mint, &self.seller),
                transfer_permit: permit_of(&self.seller_ata),
                hook_program: HOOK_PROGRAM_ID,
                token_program: spl_token_2022::ID,
                payment_token_program: spl_token_2022::ID,
                associated_token_program: anchor_spl::associated_token::ID,
                system_program: anchor_lang::system_program::ID,
            }
            .to_account_metas(None),
            data: caprail::instruction::AcceptOffer { amount }.data(),
        }
    }

    fn accept(&self, amount: u64) -> InstructionResult {
        self.mollusk.process_instruction(
            &self.instruction(&self.buyer, &self.fee_treasury, amount),
            &self.accounts,
        )
    }

    /// Жодна з відмов не лишає слідів: і частки, і оплата — як до виклику.
    fn assert_rejected_untouched(&self, result: &InstructionResult, code: u32) {
        assert_eq!(
            custom_error_code(result),
            Some(code),
            "{:?}",
            result.program_result
        );
        self.assert_untouched(result);
    }

    fn assert_untouched(&self, result: &InstructionResult) {
        assert!(!is_success(result));
        for (key, before) in &self.accounts {
            if let Some(after) = result.get_account(key) {
                assert_eq!(after, before, "акаунт {key} змінився у відхиленій угоді");
            }
        }
    }
}

fn payment_for(amount: u64) -> u64 {
    amount * PRICE
}

fn fee_for(payment: u64) -> u64 {
    payment * u64::from(FEE_BPS) / 10_000
}

#[test]
fn buys_the_whole_offer_in_one_instruction() {
    let world = world();
    let result = world.accept(AMOUNT);
    assert!(is_success(&result), "{:?}", result.program_result);

    let payment = payment_for(AMOUNT);
    let fee = fee_for(payment);
    // Частка: у покупця на новому ATA, у продавця — решта.
    assert_eq!(token_amount(&result, &world.buyer_ata), AMOUNT);
    assert_eq!(token_amount(&result, &world.seller_ata), HELD - AMOUNT);
    // Оплата: продавцю — за вирахуванням комісії, на ATA, створений тут.
    assert_eq!(token_amount(&result, &world.seller_payment), payment - fee);
    assert_eq!(token_amount(&result, &world.fee_treasury), fee);
    assert_eq!(
        token_amount(&result, &world.buyer_payment),
        BUYER_FUNDS - payment
    );
    // Token-2022 скидає делегата, коли дозвіл вичерпано, — рахунок продавця
    // знову вільний для наступної пропозиції.
    assert_eq!(
        delegate_of(account_of(&result, &world.seller_ata)),
        (None, 0)
    );
    let offer: Offer = read(&result, &world.offer());
    assert_eq!(offer.remaining, 0);
    assert_eq!(offer.status, OfferStatus::Filled);
    assert_eq!(offer.amount, AMOUNT);

    // Найважчий шлях угоди — зі створенням обох рахунків — у бюджеті інструкції.
    let cu = result.compute_units_consumed;
    assert!(
        cu <= CU_LIMIT,
        "accept_offer коштує {cu} CU при бюджеті {CU_LIMIT}"
    );
    println!("accept_offer зі створенням двох ATA: {cu} CU із {CU_LIMIT}");

    let logs = take_logs(&world.mollusk);
    // Частку журнал бачить так само, як будь-який переказ, — від хука.
    let allowed = events::<TransferAllowed>(&logs);
    assert_eq!(allowed.len(), 1);
    assert_eq!(allowed[0].source_owner, world.seller);
    assert_eq!(allowed[0].destination_owner, world.buyer);
    assert_eq!(allowed[0].amount, AMOUNT);
    assert!(!allowed[0].from_treasury);

    let accepted = events::<OfferAccepted>(&logs);
    assert_eq!(accepted.len(), 1);
    let event = &accepted[0];
    assert_eq!(event.offer, world.offer());
    assert_eq!(event.mint, world.mint);
    assert_eq!(event.seller, world.seller);
    assert_eq!(event.buyer, world.buyer);
    assert_eq!(event.offer_id, OFFER_ID);
    assert_eq!(event.amount, AMOUNT);
    assert_eq!(event.price_per_unit, PRICE);
    assert_eq!(event.payment, payment);
    assert_eq!(event.fee, fee);
    assert_eq!(event.payment_mint, world.payment_mint);
    assert_eq!(event.remaining, 0);
    assert_eq!(event.accepted_at, now(&world.mollusk));
}

/// Частинами: після першої покупки пропозиція відкрита на залишок, і делегат
/// має дозвіл рівно на нього; друга покупка на залишок закриває її, а вже
/// наявні рахунки не перестворюються.
#[test]
fn partial_acceptance_leaves_the_rest_open() {
    let mut world = world();
    let first = 1_000;
    let result = world.accept(first);
    assert!(is_success(&result), "{:?}", result.program_result);
    let offer: Offer = read(&result, &world.offer());
    assert_eq!(offer.remaining, AMOUNT - first);
    assert_eq!(offer.status, OfferStatus::Open);
    assert_eq!(
        delegate_of(account_of(&result, &world.seller_ata)),
        (Some(world.offer()), AMOUNT - first)
    );
    world.apply(&result);
    take_logs(&world.mollusk);

    // Купити більше за залишок не можна, навіть якщо в продавця є частки.
    world.assert_rejected_untouched(
        &world.accept(AMOUNT - first + 1),
        expected(CaprailError::AmountExceedsRemaining),
    );

    let result = world.accept(AMOUNT - first);
    assert!(is_success(&result), "{:?}", result.program_result);
    let offer: Offer = read(&result, &world.offer());
    assert_eq!(offer.remaining, 0);
    assert_eq!(offer.status, OfferStatus::Filled);
    assert_eq!(token_amount(&result, &world.buyer_ata), AMOUNT);
    let payment = payment_for(AMOUNT);
    // Комісія з кожної частини окремо; при цих числах округлення не з'їдає нічого.
    assert_eq!(
        token_amount(&result, &world.fee_treasury),
        fee_for(payment_for(first)) + fee_for(payment_for(AMOUNT - first))
    );
    assert_eq!(
        token_amount(&result, &world.buyer_payment),
        BUYER_FUNDS - payment
    );
    let accepted = events::<OfferAccepted>(&take_logs(&world.mollusk));
    assert_eq!(accepted.len(), 1);
    assert_eq!(accepted[0].remaining, 0);

    // Виконана пропозиція більше нічого не продає.
    world.apply(&result);
    world.assert_rejected_untouched(&world.accept(1), expected(CaprailError::OfferNotOpen));
}

/// Дрібна угода, де комісія округлюється до нуля: переказу на рахунок
/// платформи немає, продавець отримує всю оплату.
#[test]
fn zero_fee_skips_the_fee_transfer() {
    let mut world = world();
    let mut offer = offer_state(&world.mint, &world.seller, AMOUNT, 0);
    offer.price_per_unit = 1;
    world.set_offer(&offer);
    // 50 × 1 × 100 / 10 000 = 0,5 → 0.
    let result = world.accept(50);
    assert!(is_success(&result), "{:?}", result.program_result);
    assert_eq!(token_amount(&result, &world.seller_payment), 50);
    assert_eq!(token_amount(&result, &world.fee_treasury), 0);
    let accepted = events::<OfferAccepted>(&take_logs(&world.mollusk));
    assert_eq!(accepted[0].fee, 0);
    assert_eq!(accepted[0].payment, 50);
}

/// Недопущеного покупця зупиняє хук — тією самою причиною, що й будь-який
/// переказ; ні частка, ні оплата не рухаються.
#[test]
fn the_hook_rejects_an_unadmitted_buyer() {
    let mut world = world();
    let record = world.record;
    *world.account_mut(&record) = Account::default();
    world.assert_rejected_untouched(&world.accept(AMOUNT), expected(CaprailError::NotAccredited));

    // Допуск, що сплив, — інша причина, та сама зупинка.
    let mut world = self::world();
    advance(&mut world.mollusk, YEAR);
    world.assert_rejected_untouched(
        &world.accept(AMOUNT),
        expected(CaprailError::AccreditationExpired),
    );
}

#[test]
fn refuses_zero_and_self_trade() {
    let mut world = world();
    world.assert_rejected_untouched(&world.accept(0), expected(CaprailError::InvalidAmount));

    // Продавець купує сам у себе: власність не міняється, а журнал показав би
    // «покупку» і комісію ні за що. Окремої помилки немає — ATA покупця тут і є
    // рахунком продавця, і Anchor відкидає два однакові `mut`-акаунти сам. Щоб
    // дійти до цієї перевірки, рахунок оплати продавця мусить існувати (Anchor
    // спершу десеріалізує всі акаунти), а запис реєстру — лише тому, що mollusk
    // вимагає в стенді кожен акаунт інструкції.
    let seller_payment = world.seller_payment;
    *world.account_mut(&seller_payment) = plain_token_account(
        &world.mollusk,
        &world.payment_mint,
        &world.seller,
        BUYER_FUNDS,
    );
    let seller_record = InvestorRecord::find_address(&world.mint, &world.seller).0;
    world.accounts.push(empty(seller_record));
    let result = world.mollusk.process_instruction(
        &world.instruction(&world.seller, &world.fee_treasury, AMOUNT),
        &world.accounts,
    );
    assert_eq!(
        custom_error_code(&result),
        Some(anchor_code(ErrorCode::ConstraintDuplicateMutableAccount)),
        "{:?}",
        result.program_result
    );
}

/// Продавець зняв делегування або вивів частки — пропозиція `stale`, і
/// причина названа нашою помилкою, а не кодом токен-програми.
#[test]
fn a_stale_offer_is_refused_by_name() {
    let mut world = world();
    let seller_ata = world.seller_ata;
    let mut revoked = hook_token_account(&world.mollusk, &world.mint, &world.seller, HELD);
    *world.account_mut(&seller_ata) = revoked.clone();
    world.assert_rejected_untouched(&world.accept(AMOUNT), expected(CaprailError::OfferStale));

    // Делегат чужий — те саме.
    set_delegate(&mut revoked, &Pubkey::new_unique(), AMOUNT);
    *world.account_mut(&seller_ata) = revoked;
    world.assert_rejected_untouched(&world.accept(AMOUNT), expected(CaprailError::OfferStale));

    // Делегування стоїть, а часток уже менше, ніж купують.
    let offer = world.offer();
    let mut short = hook_token_account(&world.mollusk, &world.mint, &world.seller, AMOUNT - 1);
    set_delegate(&mut short, &offer, AMOUNT);
    *world.account_mut(&seller_ata) = short;
    world.assert_rejected_untouched(&world.accept(AMOUNT), expected(CaprailError::OfferStale));
    // Меншу частину купити ще можна.
    assert!(is_success(&world.accept(AMOUNT - 1)));
}

/// У покупця не вистачає на оплату: частка вже пішла б першим переказом, але
/// відмова другого відкочує все — половини угоди немає (SC-006 у малому).
#[test]
fn a_failed_payment_undoes_the_share_transfer() {
    let mut world = world();
    let buyer_payment = world.buyer_payment;
    *world.account_mut(&buyer_payment) = plain_token_account(
        &world.mollusk,
        &world.payment_mint,
        &world.buyer,
        payment_for(AMOUNT) - 1,
    );
    let result = world.accept(AMOUNT);
    world.assert_untouched(&result);
}

#[test]
fn refuses_closed_offers_and_the_rofr_window() {
    for status in [OfferStatus::Filled, OfferStatus::Cancelled] {
        let mut world = world();
        let mut offer = offer_state(&world.mint, &world.seller, AMOUNT, 0);
        offer.status = status;
        world.set_offer(&offer);
        world.assert_rejected_untouched(&world.accept(1), expected(CaprailError::OfferNotOpen));
    }

    // Вікно ROFR ще відкрите — купити може лише компанія (US4); щойно минуло —
    // будь-хто допущений.
    let mut world = world();
    let until = now(&world.mollusk) + 60;
    world.set_offer(&offer_state(&world.mint, &world.seller, AMOUNT, until));
    world.assert_rejected_untouched(
        &world.accept(AMOUNT),
        expected(CaprailError::RofrWindowOpen),
    );
    advance(&mut world.mollusk, 60);
    assert!(is_success(&world.accept(AMOUNT)));
}

/// Комісія йде лише на рахунок із конфігу платформи — покупець не може
/// підставити свій.
#[test]
fn fee_goes_only_to_the_platform_treasury() {
    let mut world = world();
    let decoy = Pubkey::new_unique();
    let decoy_account = plain_token_account(&world.mollusk, &world.payment_mint, &world.buyer, 0);
    world.accounts.push((decoy, decoy_account));
    let result = world.mollusk.process_instruction(
        &world.instruction(&world.buyer, &decoy, AMOUNT),
        &world.accounts,
    );
    assert_eq!(
        custom_error_code(&result),
        Some(anchor_code(ErrorCode::ConstraintHasOne)),
        "{:?}",
        result.program_result
    );
}
