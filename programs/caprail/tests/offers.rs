//! `create_offer` і `cancel_offer` (T036): пропозиція без ескроу.
//!
//! Доводиться, що токени не рухаються — продавець лишається власником, а
//! `Offer` PDA отримує делегування рівно на `amount`; що скасування знімає
//! лише своє делегування; і що кожна помилка вводу відхиляється до того, як
//! з'явиться акаунт, який індекс показав би на ринку.

mod common;

use anchor_lang::error::ErrorCode;
use anchor_lang::prelude::Pubkey;
use anchor_lang::{InstructionData, ToAccountMetas};
use anchor_spl::token_2022::spl_token_2022;
use caprail::events::{OfferCancelled, OfferCreated};
use caprail::instructions::CreateOfferArgs;
use caprail::state::{Company, Offer, OfferStatus, PlatformConfig, TokenConfig, TransferPolicy};
use caprail::CaprailError;
use common::*;
use mollusk_svm::result::InstructionResult;
use mollusk_svm::Mollusk;
use solana_account::Account;
use solana_instruction::Instruction;

const COMPANY_ID: u64 = 21;
const SUPPLY: u64 = 1_000_000;
const HELD: u64 = 10_000;
const OFFER_ID: u64 = 7;
const AMOUNT: u64 = 4_000;
// 1,25 одиниці стейблкоїна (6 знаків) за частку.
const PRICE: u64 = 1_250_000;

/// Компанія з токеном, платформа і продавець, що вже тримає `HELD` часток.
struct World {
    mollusk: Mollusk,
    seller: Pubkey,
    platform: Pubkey,
    payment_mint: Pubkey,
    company: Pubkey,
    token_config: Pubkey,
    mint: Pubkey,
    seller_ata: Pubkey,
    accounts: Vec<(Pubkey, Account)>,
}

fn world() -> World {
    let mollusk = mollusk();
    let seller = Pubkey::new_unique();
    let (company, _) = Company::find_address(COMPANY_ID);
    let (mint, _) = TokenConfig::find_mint_address(&company, 0);
    let (token_config, config_bump) = TokenConfig::find_address(&mint);
    let (platform, platform_bump) = PlatformConfig::find_address();
    let payment_mint = Pubkey::new_unique();
    let seller_ata = ata(&seller, &mint);

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
        authority: Pubkey::new_unique(),
        payment_mint,
        fee_treasury: Pubkey::new_unique(),
        fee_bps: 100,
        bump: platform_bump,
    };
    let accounts = vec![
        (seller, funded_wallet()),
        (platform, anchor_account(&mollusk, &platform_state)),
        (token_config, anchor_account(&mollusk, &config_state)),
        (mint, hook_mint(&mollusk, &company, SUPPLY, DECIMALS)),
        (
            seller_ata,
            hook_token_account(&mollusk, &mint, &seller, HELD),
        ),
        empty(offer_of(&mint, &seller, OFFER_ID)),
        token_program(),
        system_program(),
    ];
    World {
        mollusk,
        seller,
        platform,
        payment_mint,
        company,
        token_config,
        mint,
        seller_ata,
        accounts,
    }
}

fn offer_of(mint: &Pubkey, seller: &Pubkey, offer_id: u64) -> Pubkey {
    Offer::find_address(mint, seller, offer_id).0
}

impl World {
    fn offer(&self) -> Pubkey {
        offer_of(&self.mint, &self.seller, OFFER_ID)
    }

    fn account(&self, key: &Pubkey) -> &Account {
        &self
            .accounts
            .iter()
            .find(|(k, _)| k == key)
            .expect("акаунт стенду")
            .1
    }

    fn account_mut(&mut self, key: &Pubkey) -> &mut Account {
        &mut self
            .accounts
            .iter_mut()
            .find(|(k, _)| k == key)
            .expect("акаунт стенду")
            .1
    }

    /// Стан після інструкції стає стартовим для наступної — як у мережі.
    fn apply(&mut self, result: &InstructionResult) {
        for (key, account) in &result.resulting_accounts {
            if let Some(slot) = self.accounts.iter_mut().find(|(k, _)| k == key) {
                slot.1 = account.clone();
            }
        }
    }

    fn create_instruction(&self, token_config: &Pubkey, args: CreateOfferArgs) -> Instruction {
        Instruction {
            program_id: caprail::ID,
            accounts: caprail::accounts::CreateOffer {
                seller: self.seller,
                platform: self.platform,
                token_config: *token_config,
                mint: self.mint,
                seller_token_account: self.seller_ata,
                offer: offer_of(&self.mint, &self.seller, args.offer_id),
                token_program: spl_token_2022::ID,
                system_program: anchor_lang::system_program::ID,
            }
            .to_account_metas(None),
            data: caprail::instruction::CreateOffer { args }.data(),
        }
    }

    fn create(&self, amount: u64, price_per_unit: u64) -> InstructionResult {
        let args = CreateOfferArgs {
            offer_id: OFFER_ID,
            amount,
            price_per_unit,
        };
        self.mollusk.process_instruction(
            &self.create_instruction(&self.token_config, args),
            &self.accounts,
        )
    }

    fn cancel_instruction(&self, signer: &Pubkey) -> Instruction {
        Instruction {
            program_id: caprail::ID,
            accounts: caprail::accounts::CancelOffer {
                seller: *signer,
                offer: self.offer(),
                mint: self.mint,
                seller_token_account: ata(signer, &self.mint),
                token_program: spl_token_2022::ID,
            }
            .to_account_metas(None),
            data: caprail::instruction::CancelOffer {}.data(),
        }
    }

    fn cancel(&self) -> InstructionResult {
        self.mollusk
            .process_instruction(&self.cancel_instruction(&self.seller), &self.accounts)
    }

    /// Стенд із уже відкритою пропозицією — стартова точка тестів скасування.
    fn with_open_offer() -> World {
        let mut world = world();
        let result = world.create(AMOUNT, PRICE);
        assert!(is_success(&result), "{:?}", result.program_result);
        world.apply(&result);
        take_logs(&world.mollusk);
        world
    }
}

fn assert_error(result: &InstructionResult, code: u32) {
    assert_eq!(
        custom_error_code(result),
        Some(code),
        "{:?}",
        result.program_result
    );
}

#[test]
fn creates_an_offer_by_delegation_and_emits_the_event() {
    let world = world();
    let result = world.create(AMOUNT, PRICE);
    assert!(is_success(&result), "{:?}", result.program_result);
    let offer_key = world.offer();

    let account = account_of(&result, &offer_key);
    assert_eq!(account.owner, caprail::ID);
    assert_eq!(account.data.len(), Offer::SPACE);
    let offer: Offer = read(&result, &offer_key);
    assert_eq!(offer.mint, world.mint);
    assert_eq!(offer.seller, world.seller);
    assert_eq!(offer.offer_id, OFFER_ID);
    assert_eq!(offer.amount, AMOUNT);
    assert_eq!(offer.remaining, AMOUNT);
    assert_eq!(offer.price_per_unit, PRICE);
    assert_eq!(offer.rofr_until, 0);
    assert_eq!(offer.status, OfferStatus::Open);
    assert_eq!(offer.created_at, now(&world.mollusk));
    assert_eq!(
        offer.bump,
        Offer::find_address(&world.mint, &world.seller, OFFER_ID).1
    );

    // Без ескроу: частки не зрушили, пропозиція лише має право їх переказати.
    assert_eq!(token_amount(&result, &world.seller_ata), HELD);
    assert_eq!(
        delegate_of(account_of(&result, &world.seller_ata)),
        (Some(offer_key), AMOUNT)
    );

    let emitted = events::<OfferCreated>(&take_logs(&world.mollusk));
    assert_eq!(emitted.len(), 1);
    let event = &emitted[0];
    assert_eq!(event.offer, offer_key);
    assert_eq!(event.company, world.company);
    assert_eq!(event.mint, world.mint);
    assert_eq!(event.seller, world.seller);
    assert_eq!(event.offer_id, OFFER_ID);
    assert_eq!(event.amount, AMOUNT);
    assert_eq!(event.price_per_unit, PRICE);
    assert_eq!(event.payment_mint, world.payment_mint);
    assert_eq!(event.rofr_until, 0);
    assert_eq!(event.created_at, now(&world.mollusk));
}

/// Увесь баланс — теж пропозиція; понад нього, нуль, нульова ціна і оплата,
/// що не вміщається в u64, — помилки вводу, і акаунта не лишається.
#[test]
fn refuses_bad_terms_without_leaving_an_account() {
    let world = world();
    assert!(is_success(&world.create(HELD, PRICE)));

    let cases = [
        (0, PRICE, CaprailError::InvalidOffer),
        (AMOUNT, 0, CaprailError::InvalidOffer),
        (2, u64::MAX / 2 + 1, CaprailError::InvalidOffer),
        (HELD + 1, PRICE, CaprailError::OfferExceedsBalance),
    ];
    for (amount, price, error) in cases {
        let result = world.create(amount, price);
        assert_error(&result, expected(error));
        assert!(account_of(&result, &world.offer()).data.is_empty());
        assert_eq!(
            delegate_of(account_of(&result, &world.seller_ata)),
            (None, 0)
        );
    }
}

/// Один делегат на рахунок: друга пропозиція мовчки забрала б делегування в
/// першої. Відмова, а чуже делегування лишається як було.
#[test]
fn refuses_while_the_account_is_delegated_elsewhere() {
    let mut world = world();
    let other = Pubkey::new_unique();
    let seller_ata = world.seller_ata;
    set_delegate(world.account_mut(&seller_ata), &other, 1);

    let result = world.create(AMOUNT, PRICE);
    assert_error(&result, expected(CaprailError::DelegationInUse));
    assert_eq!(
        delegate_of(world.account(&world.seller_ata)),
        (Some(other), 1)
    );

    // Та сама відмова для власної відкритої пропозиції під іншим id.
    let world = World::with_open_offer();
    let args = CreateOfferArgs {
        offer_id: OFFER_ID + 1,
        amount: 1,
        price_per_unit: PRICE,
    };
    let mut accounts = world.accounts.clone();
    accounts.push(empty(offer_of(&world.mint, &world.seller, OFFER_ID + 1)));
    let result = world.mollusk.process_instruction(
        &world.create_instruction(&world.token_config, args),
        &accounts,
    );
    assert_error(&result, expected(CaprailError::DelegationInUse));
}

/// Пропозиція лише на токен CapRail і лише після `init_platform`: без
/// платформи ціна не має одиниць.
#[test]
fn needs_a_caprail_token_and_an_initialized_platform() {
    let mut world = world();
    let foreign_mint = Pubkey::new_unique();
    let (foreign_config, bump) = TokenConfig::find_address(&foreign_mint);
    let mut config: TokenConfig = {
        let data = &world.account(&world.token_config).data;
        anchor_lang::AccountDeserialize::try_deserialize(&mut data.as_slice()).expect("конфіг")
    };
    config.mint = foreign_mint;
    config.bump = bump;
    world
        .accounts
        .push((foreign_config, anchor_account(&world.mollusk, &config)));
    let args = CreateOfferArgs {
        offer_id: OFFER_ID,
        amount: AMOUNT,
        price_per_unit: PRICE,
    };
    let result = world.mollusk.process_instruction(
        &world.create_instruction(&foreign_config, args),
        &world.accounts,
    );
    assert_error(&result, expected(CaprailError::TokenConfigMismatch));

    let mut world = self::world();
    let platform = world.platform;
    *world.account_mut(&platform) = Account::default();
    assert_error(
        &world.create(AMOUNT, PRICE),
        anchor_code(ErrorCode::AccountNotInitialized),
    );
}

#[test]
fn cancel_revokes_the_delegation_and_keeps_the_account() {
    let world = World::with_open_offer();
    let result = world.cancel();
    assert!(is_success(&result), "{:?}", result.program_result);

    let offer: Offer = read(&result, &world.offer());
    assert_eq!(offer.status, OfferStatus::Cancelled);
    assert_eq!(offer.remaining, AMOUNT);
    assert_eq!(token_amount(&result, &world.seller_ata), HELD);
    assert_eq!(
        delegate_of(account_of(&result, &world.seller_ata)),
        (None, 0)
    );

    let emitted = events::<OfferCancelled>(&take_logs(&world.mollusk));
    assert_eq!(emitted.len(), 1);
    let event = &emitted[0];
    assert_eq!(event.offer, world.offer());
    assert_eq!(event.mint, world.mint);
    assert_eq!(event.seller, world.seller);
    assert_eq!(event.offer_id, OFFER_ID);
    assert_eq!(event.remaining, AMOUNT);
    assert!(event.delegation_revoked);
    assert_eq!(event.cancelled_at, now(&world.mollusk));
}

/// Скасована пропозиція не звільняє свій id: та сама адреса в індексі
/// означала б дві різні пропозиції під одним ключем.
#[test]
fn a_cancelled_offer_id_is_not_reused() {
    let mut world = World::with_open_offer();
    let result = world.cancel();
    assert!(is_success(&result), "{:?}", result.program_result);
    world.apply(&result);

    let result = world.create(AMOUNT, PRICE);
    assert!(!is_success(&result), "{:?}", result.program_result);
    assert_eq!(
        read::<Offer>(&result, &world.offer()).status,
        OfferStatus::Cancelled
    );
}

/// Скасувати може лише продавець і лише відкриту пропозицію.
#[test]
fn only_the_seller_cancels_and_only_an_open_offer() {
    let mut world = World::with_open_offer();
    let stranger = Pubkey::new_unique();
    let stranger_ata = ata(&stranger, &world.mint);
    world.accounts.push((stranger, funded_wallet()));
    world.accounts.push((
        stranger_ata,
        hook_token_account(&world.mollusk, &world.mint, &stranger, 0),
    ));
    let result = world
        .mollusk
        .process_instruction(&world.cancel_instruction(&stranger), &world.accounts);
    assert_error(&result, expected(CaprailError::Unauthorized));

    let result = world.cancel();
    world.apply(&result);
    assert_error(&world.cancel(), expected(CaprailError::OfferNotOpen));

    // Виконану до кінця теж не скасувати — `accept_offer` (T037) ставить `Filled`.
    let mut world = World::with_open_offer();
    let offer_key = world.offer();
    let mut offer: Offer = {
        let data = &world.account(&offer_key).data;
        anchor_lang::AccountDeserialize::try_deserialize(&mut data.as_slice()).expect("пропозиція")
    };
    offer.remaining = 0;
    offer.status = OfferStatus::Filled;
    *world.account_mut(&offer_key) = anchor_account(&world.mollusk, &offer);
    assert_error(&world.cancel(), expected(CaprailError::OfferNotOpen));
}

/// Продавець уже віддав рахунок іншому делегату: скасування проходить, але
/// чуже делегування не чіпає — і подія це каже.
#[test]
fn cancel_leaves_a_foreign_delegation_alone() {
    let mut world = World::with_open_offer();
    let other = Pubkey::new_unique();
    let seller_ata = world.seller_ata;
    set_delegate(world.account_mut(&seller_ata), &other, 5);

    let result = world.cancel();
    assert!(is_success(&result), "{:?}", result.program_result);
    assert_eq!(
        read::<Offer>(&result, &world.offer()).status,
        OfferStatus::Cancelled
    );
    assert_eq!(
        delegate_of(account_of(&result, &world.seller_ata)),
        (Some(other), 5)
    );
    let emitted = events::<OfferCancelled>(&take_logs(&world.mollusk));
    assert_eq!(emitted.len(), 1);
    assert!(!emitted[0].delegation_revoked);
}
