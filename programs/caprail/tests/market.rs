//! Прогони SC-006 і SC-007 (T038): ринок на кількох продавцях і покупцях.
//!
//! `accept_offer.rs` проходить кожну гілку угоди по одному разу; тут — те саме
//! правило на потоці, де стан накопичується, як у мережі: рахунки покупців
//! створює перша угода і далі вони живуть, пропозиції виконуються частинами, а
//! виконану продавець змінює новою справжнім `create_offer`.
//!
//! SC-006: 100 угод, з них 20 зірвано на другій частині обміну — на оплаті
//! продавцю або на комісії. Зрив робиться станом рахунків (бракує коштів,
//! рахунок заморожено), а не зміною програми: так угода зривається і в мережі.
//! Для кожної зірваної угоди лог засвідчує, що частка вже пройшла хук і що
//! впав саме той переказ, який зривали, — інакше «нуль половинчастих угод»
//! було б порожнім твердженням про угоди, що впали до першого переказу.
//!
//! SC-007: 200 спроб прийняти пропозицію недопущеними покупцями п'яти видів.
//! Кожну зупиняє хук усередині першого переказу: оплата не починається, і
//! жоден акаунт не змінюється. Контроль — допущений покупець на тому самому
//! стані купує.

mod common;

use anchor_lang::prelude::Pubkey;
use anchor_lang::{AccountDeserialize, InstructionData, ToAccountMetas};
use anchor_spl::token_2022::spl_token_2022;
use anchor_spl::token_2022::spl_token_2022::error::TokenError;
use anchor_spl::token_2022::spl_token_2022::extension::{
    StateWithExtensions, StateWithExtensionsMut,
};
use anchor_spl::token_2022::spl_token_2022::state::{Account as TokenAccount, AccountState};
use caprail::events::{OfferAccepted, TransferAllowed};
use caprail::hook::{extra_account_metas, EXTRA_ACCOUNT_COUNT, HOOK_PROGRAM_ID};
use caprail::instructions::CreateOfferArgs;
use caprail::state::{
    Company, InvestorRecord, InvestorStatus, Offer, PlatformConfig, TokenConfig, TransferPolicy,
    GRANT_SEED, PERMIT_SEED,
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

const COMPANY_ID: u64 = 38;
const SELLERS: usize = 4;
const BUYERS: usize = 10;
const HELD: u64 = 1_000_000;
const SUPPLY: u64 = 10_000_000;
// Менша за сумарний попит на продавця — пропозиції виконуються посеред прогону
// і змінюються новими.
const OFFER_SIZE: u64 = 3_000;
const MAX_TRADE: u64 = 500;
// 1,25 одиниці стейблкоїна (6 знаків) за частку.
const PRICE: u64 = 1_250_000;
const PAYMENT_DECIMALS: u8 = 6;
const FEE_BPS: u16 = 100;
const BUYER_FUNDS: u64 = 1_000_000_000_000;
const YEAR: i64 = 365 * 24 * 60 * 60;
const DAY: i64 = 24 * 60 * 60;

const TRADES: usize = 100;
const ATTEMPTS: usize = 200;

type Accounts = Vec<(Pubkey, Account)>;

/// Детермінований генератор (xorshift64): прогін відтворюється, а падіння
/// називає номер угоди.
struct Rng(u64);

impl Rng {
    fn below(&mut self, n: u64) -> u64 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0 = x;
        x % n
    }
}

struct Seller {
    wallet: Pubkey,
    shares: Pubkey,
    payment: Pubkey,
    offer_id: u64,
}

/// Компанія з токеном, платформа, продавці з відкритими пропозиціями на
/// `OFFER_SIZE` і допущені покупці зі стейблкоїном. Рахунків покупців під
/// частки і продавців під оплату ще немає — їх створить перша угода.
struct Market {
    mollusk: Mollusk,
    platform: Pubkey,
    token_config: Pubkey,
    mint: Pubkey,
    payment_mint: Pubkey,
    fee_treasury: Pubkey,
    list: Pubkey,
    sellers: Vec<Seller>,
    buyers: Vec<Pubkey>,
    accounts: Accounts,
}

/// Баланси однієї угоди — те, що рахує SC-006.
#[derive(Clone, Copy, Debug, PartialEq)]
struct Ledger {
    seller_shares: u64,
    buyer_shares: u64,
    buyer_payment: u64,
    seller_payment: u64,
    treasury: u64,
    remaining: u64,
}

impl Ledger {
    /// Одна частина обміну відбулась, а інша ні — те, чого SC-006 не допускає.
    fn one_sided(&self, after: &Ledger) -> bool {
        let shares_moved =
            self.seller_shares != after.seller_shares || self.buyer_shares != after.buyer_shares;
        let paid = self.buyer_payment != after.buyer_payment
            || self.seller_payment != after.seller_payment
            || self.treasury != after.treasury;
        shares_moved != paid
    }
}

fn record(
    mint: &Pubkey,
    wallet: &Pubkey,
    status: InvestorStatus,
    expires_at: i64,
) -> InvestorRecord {
    InvestorRecord {
        mint: *mint,
        wallet: *wallet,
        status,
        expires_at,
        jurisdiction: *b"UA",
        investor_type: 1,
        updated_at: GENESIS_UNIX_TS,
        updated_by: Pubkey::new_unique(),
        bump: InvestorRecord::find_address(mint, wallet).1,
    }
}

fn grant_of(mint: &Pubkey, sender: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[GRANT_SEED, mint.as_ref(), sender.as_ref()], &caprail::ID).0
}

fn permit_of(source: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[PERMIT_SEED, source.as_ref()], &caprail::ID).0
}

fn find<'a>(accounts: &'a [(Pubkey, Account)], key: &Pubkey) -> Option<&'a Account> {
    accounts.iter().find(|(k, _)| k == key).map(|(_, a)| a)
}

fn slot<'a>(accounts: &'a mut [(Pubkey, Account)], key: &Pubkey) -> &'a mut Account {
    &mut accounts
        .iter_mut()
        .find(|(k, _)| k == key)
        .expect("акаунт стенду")
        .1
}

/// Рахунку, якого ще немає, — нуль: так його бачить і гаманець.
fn balance(accounts: &[(Pubkey, Account)], key: &Pubkey) -> u64 {
    match find(accounts, key) {
        Some(account) if !account.data.is_empty() => {
            StateWithExtensions::<TokenAccount>::unpack(&account.data)
                .expect("токен-акаунт має читатися")
                .base
                .amount
        }
        _ => 0,
    }
}

fn edit_token_account(account: &mut Account, edit: impl FnOnce(&mut TokenAccount)) {
    let mut state =
        StateWithExtensionsMut::<TokenAccount>::unpack(&mut account.data).expect("токен-акаунт");
    edit(&mut state.base);
    state.pack_base();
}

fn payment_for(amount: u64) -> u64 {
    amount * PRICE
}

fn fee_for(payment: u64) -> u64 {
    payment * u64::from(FEE_BPS) / 10_000
}

/// Скільки разів угода сама викликала Token-2022 (глибина 2): частка, оплата
/// продавцю, комісія — саме в такому порядку. Створення рахунків іде через
/// ATA-програму глибше і сюди не потрапляє.
fn token_calls(logs: &[String]) -> usize {
    let line = format!("Program {} invoke [2]", spl_token_2022::ID);
    logs.iter().filter(|l| **l == line).count()
}

fn market() -> Market {
    let mollusk = mollusk();
    let platform_authority = Pubkey::new_unique();
    let (company, _) = Company::find_address(COMPANY_ID);
    let (mint, _) = TokenConfig::find_mint_address(&company, 0);
    let (token_config, config_bump) = TokenConfig::find_address(&mint);
    let (platform, platform_bump) = PlatformConfig::find_address();
    let payment_mint = Pubkey::new_unique();
    let fee_treasury = ata(&platform_authority, &payment_mint);
    let list = get_extra_account_metas_address(&mint, &HOOK_PROGRAM_ID);

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

    let mut accounts = vec![
        (platform, anchor_account(&mollusk, &platform_state)),
        (token_config, anchor_account(&mollusk, &config_state)),
        (mint, hook_mint(&mollusk, &company, SUPPLY, DECIMALS)),
        (
            payment_mint,
            plain_mint(
                &mollusk,
                &platform_authority,
                BUYER_FUNDS * BUYERS as u64,
                PAYMENT_DECIMALS,
            ),
        ),
        (
            fee_treasury,
            plain_token_account(&mollusk, &payment_mint, &platform_authority, 0),
        ),
        (list, rent_exempt(&mollusk, list_data, HOOK_PROGRAM_ID)),
        caprail_program(),
        hook_program(),
        token_program(),
        ata_program(),
        system_program(),
    ];

    let sellers: Vec<Seller> = (0..SELLERS)
        .map(|_| {
            let wallet = Pubkey::new_unique();
            let seller = Seller {
                wallet,
                shares: ata(&wallet, &mint),
                payment: ata(&wallet, &payment_mint),
                offer_id: 0,
            };
            accounts.extend([
                (wallet, funded_wallet()),
                (
                    seller.shares,
                    hook_token_account(&mollusk, &mint, &wallet, HELD),
                ),
                empty(seller.payment),
                empty(grant_of(&mint, &wallet)),
                empty(permit_of(&seller.shares)),
            ]);
            seller
        })
        .collect();

    let buyers: Vec<Pubkey> = (0..BUYERS)
        .map(|_| {
            let wallet = Pubkey::new_unique();
            let admitted = record(
                &mint,
                &wallet,
                InvestorStatus::Approved,
                GENESIS_UNIX_TS + YEAR,
            );
            accounts.extend([
                (wallet, funded_wallet()),
                (
                    InvestorRecord::find_address(&mint, &wallet).0,
                    anchor_account(&mollusk, &admitted),
                ),
                empty(ata(&wallet, &mint)),
                (
                    ata(&wallet, &payment_mint),
                    plain_token_account(&mollusk, &payment_mint, &wallet, BUYER_FUNDS),
                ),
            ]);
            wallet
        })
        .collect();

    let mut market = Market {
        mollusk,
        platform,
        token_config,
        mint,
        payment_mint,
        fee_treasury,
        list,
        sellers,
        buyers,
        accounts,
    };
    for s in 0..SELLERS {
        market.open_offer(s);
    }
    market
}

impl Market {
    fn offer(&self, s: usize) -> Pubkey {
        let seller = &self.sellers[s];
        Offer::find_address(&self.mint, &seller.wallet, seller.offer_id).0
    }

    fn remaining(&self, s: usize) -> u64 {
        let account = find(&self.accounts, &self.offer(s)).expect("пропозиція продавця");
        Offer::try_deserialize(&mut &account.data[..])
            .expect("пропозиція має читатися")
            .remaining
    }

    fn run(
        &self,
        instruction: &Instruction,
        accounts: &[(Pubkey, Account)],
    ) -> (InstructionResult, Vec<String>) {
        let result = self.mollusk.process_instruction(instruction, accounts);
        (result, take_logs(&self.mollusk))
    }

    /// Стан після інструкції стає стартовим для наступної — як у мережі.
    fn apply(&mut self, result: &InstructionResult) {
        for (key, account) in &result.resulting_accounts {
            if let Some(slot) = self.accounts.iter_mut().find(|(k, _)| k == key) {
                slot.1 = account.clone();
            }
        }
    }

    /// Нова пропозиція продавця справжнім `create_offer` — з делегуванням, яке
    /// ставить сама інструкція.
    fn open_offer(&mut self, s: usize) {
        let offer = self.offer(s);
        self.accounts.push(empty(offer));
        let seller = &self.sellers[s];
        let args = CreateOfferArgs {
            offer_id: seller.offer_id,
            amount: OFFER_SIZE,
            price_per_unit: PRICE,
        };
        let instruction = Instruction {
            program_id: caprail::ID,
            accounts: caprail::accounts::CreateOffer {
                seller: seller.wallet,
                platform: self.platform,
                token_config: self.token_config,
                mint: self.mint,
                seller_token_account: seller.shares,
                offer,
                token_program: spl_token_2022::ID,
                system_program: anchor_lang::system_program::ID,
            }
            .to_account_metas(None),
            data: caprail::instruction::CreateOffer { args }.data(),
        };
        let (result, _) = self.run(&instruction, &self.accounts);
        assert!(
            is_success(&result),
            "create_offer: {:?}",
            result.program_result
        );
        self.apply(&result);
    }

    fn accept_instruction(&self, s: usize, buyer: &Pubkey, amount: u64) -> Instruction {
        let seller = &self.sellers[s];
        Instruction {
            program_id: caprail::ID,
            accounts: caprail::accounts::AcceptOffer {
                buyer: *buyer,
                platform: self.platform,
                offer: self.offer(s),
                seller: seller.wallet,
                token_config: self.token_config,
                mint: self.mint,
                seller_token_account: seller.shares,
                buyer_token_account: ata(buyer, &self.mint),
                payment_mint: self.payment_mint,
                buyer_payment_account: ata(buyer, &self.payment_mint),
                seller_payment_account: seller.payment,
                fee_treasury: self.fee_treasury,
                extra_account_meta_list: self.list,
                state_program: caprail::ID,
                investor_record: InvestorRecord::find_address(&self.mint, buyer).0,
                grant: grant_of(&self.mint, &seller.wallet),
                transfer_permit: permit_of(&seller.shares),
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

    fn ledger(&self, accounts: &[(Pubkey, Account)], s: usize, buyer: &Pubkey) -> Ledger {
        let seller = &self.sellers[s];
        let offer = find(accounts, &self.offer(s)).expect("пропозиція продавця");
        Ledger {
            seller_shares: balance(accounts, &seller.shares),
            buyer_shares: balance(accounts, &ata(buyer, &self.mint)),
            buyer_payment: balance(accounts, &ata(buyer, &self.payment_mint)),
            seller_payment: balance(accounts, &seller.payment),
            treasury: balance(accounts, &self.fee_treasury),
            remaining: Offer::try_deserialize(&mut &offer.data[..])
                .expect("пропозиція має читатися")
                .remaining,
        }
    }

    fn assert_untouched(
        &self,
        accounts: &[(Pubkey, Account)],
        result: &InstructionResult,
        what: &str,
    ) {
        assert!(!is_success(result), "{what}: угода мала не пройти");
        for (key, before) in accounts {
            if let Some(after) = result.get_account(key) {
                assert_eq!(
                    after, before,
                    "{what}: акаунт {key} змінився у відхиленій угоді"
                );
            }
        }
    }
}

// ── SC-006 ───────────────────────────────────────────────────────────────────

/// Як зірвати другу частину обміну, коли частка вже пішла.
#[derive(Clone, Copy, Debug)]
enum Breakage {
    /// Покупцю бракує на оплату продавцю.
    PaymentShort,
    /// На оплату продавцю вистачає, на комісію — ні: падає третій переказ,
    /// коли два перші вже пройшли.
    FeeShort,
    BuyerPaymentFrozen,
    SellerPaymentFrozen,
    TreasuryFrozen,
}

const BREAKAGES: [Breakage; 5] = [
    Breakage::PaymentShort,
    Breakage::FeeShort,
    Breakage::BuyerPaymentFrozen,
    Breakage::SellerPaymentFrozen,
    Breakage::TreasuryFrozen,
];

impl Breakage {
    /// Котрий виклик Token-2022 угоди падає: 2 — оплата продавцю, 3 — комісія.
    fn failing_call(self) -> usize {
        match self {
            Breakage::PaymentShort
            | Breakage::BuyerPaymentFrozen
            | Breakage::SellerPaymentFrozen => 2,
            Breakage::FeeShort | Breakage::TreasuryFrozen => 3,
        }
    }

    fn error(self) -> u32 {
        match self {
            Breakage::PaymentShort | Breakage::FeeShort => TokenError::InsufficientFunds as u32,
            _ => TokenError::AccountFrozen as u32,
        }
    }
}

impl Market {
    fn break_trade(
        &self,
        accounts: &mut Accounts,
        breakage: Breakage,
        s: usize,
        buyer: &Pubkey,
        amount: u64,
    ) {
        let payment = payment_for(amount);
        let fee = fee_for(payment);
        let buyer_payment = ata(buyer, &self.payment_mint);
        let freeze = |account: &mut TokenAccount| account.state = AccountState::Frozen;
        match breakage {
            Breakage::PaymentShort => edit_token_account(slot(accounts, &buyer_payment), |a| {
                a.amount = payment - fee - 1;
            }),
            Breakage::FeeShort => edit_token_account(slot(accounts, &buyer_payment), |a| {
                a.amount = payment - 1;
            }),
            Breakage::BuyerPaymentFrozen => {
                edit_token_account(slot(accounts, &buyer_payment), freeze)
            }
            Breakage::SellerPaymentFrozen => {
                let seller = &self.sellers[s];
                let account = slot(accounts, &seller.payment);
                // Заморозити можна лише наявний рахунок; якщо продавець ще не
                // отримував оплати, він у нього вже є, але порожній.
                if account.data.is_empty() {
                    *account =
                        plain_token_account(&self.mollusk, &self.payment_mint, &seller.wallet, 0);
                }
                edit_token_account(account, freeze);
            }
            Breakage::TreasuryFrozen => {
                edit_token_account(slot(accounts, &self.fee_treasury), freeze)
            }
        }
    }
}

#[test]
fn sc006_no_trade_settles_one_side_without_the_other() {
    let mut market = market();
    let mut rng = Rng(0x5C00_6006_0000_0001);
    let mut one_sided = 0;
    let mut settled = 0;
    let mut broken = [0usize; BREAKAGES.len()];
    let mut filled = 0;
    let mut fees = 0;
    let mut max_cu = 0;

    for i in 0..TRADES {
        let s = rng.below(SELLERS as u64) as usize;
        let buyer = market.buyers[rng.below(BUYERS as u64) as usize];
        let amount = (1 + rng.below(MAX_TRADE)).min(market.remaining(s));
        let instruction = market.accept_instruction(s, &buyer, amount);

        // Кожна п'ята угода зривається, види зриву — по черзі.
        if i % 5 == 4 {
            let kind = (i / 5) % BREAKAGES.len();
            let breakage = BREAKAGES[kind];
            let what = format!("угода {i} ({breakage:?})");
            let mut accounts = market.accounts.clone();
            market.break_trade(&mut accounts, breakage, s, &buyer, amount);
            let before = market.ledger(&accounts, s, &buyer);
            let (result, logs) = market.run(&instruction, &accounts);
            if before.one_sided(&market.ledger(&result.resulting_accounts, s, &buyer)) {
                one_sided += 1;
            }
            assert_eq!(
                custom_error_code(&result),
                Some(breakage.error()),
                "{what}: {:?}",
                result.program_result
            );
            market.assert_untouched(&accounts, &result, &what);
            // Свідки: частка пройшла хук, і впав саме той переказ, який зривали.
            assert_eq!(
                events::<TransferAllowed>(&logs).len(),
                1,
                "{what}: частка мала пройти хук до зриву"
            );
            assert_eq!(
                token_calls(&logs),
                breakage.failing_call(),
                "{what}: {logs:#?}"
            );
            assert!(events::<OfferAccepted>(&logs).is_empty(), "{what}");
            broken[kind] += 1;
            continue;
        }

        let before = market.ledger(&market.accounts, s, &buyer);
        let (result, logs) = market.run(&instruction, &market.accounts);
        assert!(
            is_success(&result),
            "угода {i}: {:?}",
            result.program_result
        );
        max_cu = max_cu.max(result.compute_units_consumed);
        market.apply(&result);
        let after = market.ledger(&market.accounts, s, &buyer);
        if before.one_sided(&after) {
            one_sided += 1;
        }
        let payment = payment_for(amount);
        let fee = fee_for(payment);
        assert_eq!(
            after,
            Ledger {
                seller_shares: before.seller_shares - amount,
                buyer_shares: before.buyer_shares + amount,
                buyer_payment: before.buyer_payment - payment,
                seller_payment: before.seller_payment + payment - fee,
                treasury: before.treasury + fee,
                remaining: before.remaining - amount,
            },
            "угода {i}"
        );
        assert_eq!(token_calls(&logs), 3, "угода {i}: три перекази");
        assert_eq!(events::<OfferAccepted>(&logs).len(), 1, "угода {i}");
        settled += 1;
        fees += fee;

        if after.remaining == 0 {
            filled += 1;
            market.sellers[s].offer_id += 1;
            market.open_offer(s);
        }
    }

    println!(
        "SC-006: {TRADES} угод — проведено {settled}, зірвано {} ({broken:?}), \
         половинчастих {one_sided}; пропозицій виконано і відкрито знову {filled}; \
         найдорожча угода {max_cu} CU",
        broken.iter().sum::<usize>()
    );
    assert_eq!(
        one_sided, 0,
        "SC-006: угоди, де одна частина пройшла без іншої"
    );
    assert_eq!(settled, TRADES - TRADES / 5);
    assert_eq!(broken, [TRADES / 5 / BREAKAGES.len(); BREAKAGES.len()]);
    // Без цього прогін не пройшов би шлях «виконана пропозиція → нова».
    assert!(filled >= SELLERS, "виконано лише {filled} пропозицій");
    assert!(
        max_cu <= CU_LIMIT,
        "угода коштує {max_cu} CU при бюджеті {CU_LIMIT}"
    );

    // Підсумок по всьому ринку: ні частка, ні стейблкоїн не з'явились і не зникли.
    let shares: u64 = market
        .sellers
        .iter()
        .map(|seller| balance(&market.accounts, &seller.shares))
        .chain(
            market
                .buyers
                .iter()
                .map(|b| balance(&market.accounts, &ata(b, &market.mint))),
        )
        .sum();
    assert_eq!(shares, HELD * SELLERS as u64);
    let treasury = balance(&market.accounts, &market.fee_treasury);
    assert_eq!(treasury, fees);
    let money: u64 = market
        .sellers
        .iter()
        .map(|seller| balance(&market.accounts, &seller.payment))
        .chain(
            market
                .buyers
                .iter()
                .map(|b| balance(&market.accounts, &ata(b, &market.payment_mint))),
        )
        .sum::<u64>()
        + treasury;
    assert_eq!(money, BUYER_FUNDS * BUYERS as u64);
}

// ── SC-007 ───────────────────────────────────────────────────────────────────

/// Хто приходить купувати без допуску.
#[derive(Clone, Copy, Debug)]
enum Outsider {
    /// Запису немає: адреса порожня або на ній лише лампорти, які будь-хто
    /// може туди переказати.
    NoRecord,
    /// Запис є, але допуску ще не дали.
    Pending,
    /// Допуск відкликано, а частки з колишніх угод лишились на рахунку.
    Revoked,
    /// Допуск сплив — рівно зараз або раніше.
    Expired,
    /// Допущений в іншій компанії: запис існує, але на чужий мінт.
    OtherCompany,
}

const OUTSIDERS: [Outsider; 5] = [
    Outsider::NoRecord,
    Outsider::Pending,
    Outsider::Revoked,
    Outsider::Expired,
    Outsider::OtherCompany,
];

impl Market {
    /// Стан ринку плюс рахунки одного недопущеного покупця.
    fn with_outsider(&self, outsider: Outsider, round: usize, wallet: &Pubkey) -> Accounts {
        let mut accounts = self.accounts.clone();
        let record_address = InvestorRecord::find_address(&self.mint, wallet).0;
        let now = now(&self.mollusk);
        let later = now + YEAR;
        let at = |status, expires_at| {
            anchor_account(
                &self.mollusk,
                &record(&self.mint, wallet, status, expires_at),
            )
        };
        let mut shares = empty(ata(wallet, &self.mint));
        let record_account = match outsider {
            Outsider::NoRecord if round.is_multiple_of(2) => Account::default(),
            Outsider::NoRecord => funded_wallet(),
            Outsider::Pending => at(InvestorStatus::None, later),
            Outsider::Revoked => {
                shares.1 = hook_token_account(&self.mollusk, &self.mint, wallet, 100);
                at(InvestorStatus::Revoked, later)
            }
            // Строга межа: допуск, що спливає цієї секунди, уже не діє.
            Outsider::Expired => at(InvestorStatus::Approved, now - (round % 2) as i64 * DAY),
            Outsider::OtherCompany => {
                let other_mint = Pubkey::new_unique();
                let elsewhere = record(&other_mint, wallet, InvestorStatus::Approved, later);
                accounts.push((
                    InvestorRecord::find_address(&other_mint, wallet).0,
                    anchor_account(&self.mollusk, &elsewhere),
                ));
                Account::default()
            }
        };
        accounts.extend([
            (*wallet, funded_wallet()),
            (record_address, record_account),
            shares,
            (
                ata(wallet, &self.payment_mint),
                plain_token_account(&self.mollusk, &self.payment_mint, wallet, BUYER_FUNDS),
            ),
        ]);
        accounts
    }
}

impl Outsider {
    fn error(self) -> u32 {
        match self {
            Outsider::Expired => expected(CaprailError::AccreditationExpired),
            _ => expected(CaprailError::NotAccredited),
        }
    }
}

#[test]
fn sc007_unadmitted_buyers_never_match() {
    let market = market();
    let mut rng = Rng(0x5C00_7007_0000_0001);
    let mut matches = 0;
    let mut stopped = [0usize; OUTSIDERS.len()];
    let hook_failed = format!("Program {HOOK_PROGRAM_ID} failed");

    for i in 0..ATTEMPTS {
        let kind = i % OUTSIDERS.len();
        let outsider = OUTSIDERS[kind];
        let round = i / OUTSIDERS.len();
        let what = format!("спроба {i} ({outsider:?})");
        let s = rng.below(SELLERS as u64) as usize;
        let amount = 1 + rng.below(MAX_TRADE.min(market.remaining(s)));
        let wallet = Pubkey::new_unique();
        let accounts = market.with_outsider(outsider, round, &wallet);

        let (result, logs) = market.run(&market.accept_instruction(s, &wallet, amount), &accounts);
        if is_success(&result) || !events::<OfferAccepted>(&logs).is_empty() {
            matches += 1;
        }
        assert_eq!(
            custom_error_code(&result),
            Some(outsider.error()),
            "{what}: {:?}",
            result.program_result
        );
        market.assert_untouched(&accounts, &result, &what);
        // Свідки «зупинено до зміни балансів»: відмовив хук усередині першого
        // переказу, і угода не дійшла до виклику оплати.
        assert!(
            logs.iter().any(|l| l.starts_with(&hook_failed)),
            "{what}: {logs:#?}"
        );
        assert_eq!(token_calls(&logs), 1, "{what}: {logs:#?}");
        assert!(events::<TransferAllowed>(&logs).is_empty(), "{what}");
        stopped[kind] += 1;
    }

    println!("SC-007: {ATTEMPTS} спроб недопущених покупців ({stopped:?}) — матчів {matches}");
    assert_eq!(matches, 0, "SC-007: матчі для недопущених покупців");
    assert_eq!(stopped, [ATTEMPTS / OUTSIDERS.len(); OUTSIDERS.len()]);

    // Контроль: той самий стан, допущений покупець — угода проходить у кожного
    // продавця. Без цього 200 відмов могли б означати зламаний стенд.
    for s in 0..SELLERS {
        assert_eq!(market.remaining(s), OFFER_SIZE);
        let buyer = market.buyers[s];
        let (result, logs) = market.run(&market.accept_instruction(s, &buyer, 1), &market.accounts);
        assert!(
            is_success(&result),
            "контроль, продавець {s}: {:?}",
            result.program_result
        );
        assert_eq!(events::<OfferAccepted>(&logs).len(), 1);
    }
}
