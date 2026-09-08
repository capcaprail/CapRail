//! Спільний стенд тестів програми (T008).
//!
//! Лежить у `tests/common/`, а не в `tests/common.rs`: файл прямо в `tests/`
//! cargo вважає окремим тестовим бінарником і додає до звіту порожній
//! «running 0 tests». Тека такого не робить, а `mod common;` знаходить її
//! однаково.
//!
//! Стенд виконує зібраний `caprail.so`, а не хостову збірку крейта: перевірки
//! Anchor (`init`, `seeds`, `has_one`, `owner`) живуть у згенерованому
//! `try_accounts`, і тест на хендлер пройшов би повз рівно те, на що ми
//! покладаємось. Поруч із ним — справжній ELF Token-2022: хук викликає
//! токен-програма, і без неї жоден тест не доходить до перевірки правила.
//!
//! Тут — тільки побудова стану й читання результату. Твердження лишаються в
//! самих тестах разом зі своїми поясненнями.
//!
//! **Про «міст» між `Pubkey` mollusk і Anchor.** План передбачав конвертацію
//! через `to_bytes()`, бо mollusk сидить на `solana-pubkey 4.x`, а Anchor — на
//! `3.0`. На цьому локу обидва крейти — реекспорт одного `solana-address 2.6.1`
//! (`solana-pubkey 3.0.0` → `solana-address 1.1.0` → `pub use solana_address_v2::*`),
//! тож це один і той самий тип, і мосту немає. `pubkey_types_are_one` нижче
//! тримає це твердження під компілятором: якщо колись розійдуться — тест не
//! збереться, і міст доведеться повернути свідомо.

#![allow(dead_code)]

use anchor_lang::prelude::{AccountDeserialize, Pubkey};
use anchor_lang::solana_program::program_error::ProgramError;
use anchor_lang::solana_program::program_option::COption;
use anchor_lang::solana_program::program_pack::Pack;
use anchor_lang::{AnchorDeserialize, AnchorSerialize, Discriminator};
use anchor_spl::associated_token::get_associated_token_address_with_program_id;
use anchor_spl::token_2022::spl_token_2022::extension::immutable_owner::ImmutableOwner;
use anchor_spl::token_2022::spl_token_2022::extension::metadata_pointer::MetadataPointer;
use anchor_spl::token_2022::spl_token_2022::extension::transfer_hook::{
    TransferHook, TransferHookAccount,
};
use anchor_spl::token_2022::spl_token_2022::extension::{
    BaseStateWithExtensions, BaseStateWithExtensionsMut, ExtensionType, StateWithExtensions,
    StateWithExtensionsMut,
};
use anchor_spl::token_2022::spl_token_2022::state::{Account as TokenAccount, AccountState, Mint};
use anchor_spl::token_2022::spl_token_2022::{self, instruction as token_instruction};
use anchor_spl::token_2022_extensions::spl_token_metadata_interface::state::TokenMetadata;
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use caprail::CaprailError;
use mollusk_svm::program::{create_program_account_loader_v3, loader_keys::LOADER_V3};
use mollusk_svm::result::{InstructionResult, ProgramResult};
use mollusk_svm::Mollusk;
use mollusk_svm_programs_token::{associated_token, token2022};
use solana_account::Account;
use solana_instruction::{AccountMeta, Instruction};
use solana_svm_log_collector::LogCollector;
use spl_pod::optional_keys::OptionalNonZeroPubkey;

pub const LAMPORTS_PER_SOL: u64 = 1_000_000_000;

/// Частки — цілі: у смоук-тестах стенду знаків після коми немає. Задачі
/// створення токена візьмуть свій `decimals` із `TokenConfig`, не звідси.
pub const DECIMALS: u8 = 0;

/// «Зараз» стенду — фіксована дата, а не системний час: графіки vesting у
/// тестах рахуються від неї, і падіння має відтворюватись через рік так само.
pub const GENESIS_UNIX_TS: i64 = 1_800_000_000;
pub const GENESIS_SLOT: u64 = 1_000;

/// Приблизно 2,5 слота на секунду — щоб `advance` рухав обидві шкали в один бік.
const SLOTS_PER_2_SECONDS: i64 = 5;

// ── Стенд ────────────────────────────────────────────────────────────────────

/// Артефакт береться за явним шляхом від маніфесту, а не з пошуку mollusk по
/// `SBF_OUT_DIR`/cwd: `cargo test` виконується з `programs/caprail`, і mollusk
/// там `caprail.so` не знайде. Це той самий файл, який перевіряє `wsl-build.sh`
/// (SBPFv0), — тести ганяють рівно те, що поїде в мережу.
pub fn caprail_elf() -> Vec<u8> {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../target/deploy/caprail.so"
    );
    std::fs::read(path).unwrap_or_else(|err| {
        panic!("немає {path} ({err}) — спершу: scripts/wsl-build.sh build-sbf")
    })
}

pub fn mollusk() -> Mollusk {
    let mut mollusk = Mollusk::default();
    mollusk.add_program_with_loader_and_elf(&caprail::ID, &LOADER_V3, &caprail_elf());
    token2022::add_program(&mut mollusk);
    associated_token::add_program(&mut mollusk);
    set_clock(&mut mollusk, GENESIS_SLOT, GENESIS_UNIX_TS);
    // Без збирача логи програми нікуди не пишуться — і подій не побачити.
    mollusk.logger = Some(LogCollector::new_ref());
    mollusk
}

/// Годинник виставляється тут, а не через `Mollusk::warp_to_slot`: той
/// збирає `Clock { slot, epoch, ..Default::default() }` і скидає
/// `unix_timestamp` у нуль — а саме його читає `vested(now)`.
pub fn set_clock(mollusk: &mut Mollusk, slot: u64, unix_timestamp: i64) {
    let clock = &mut mollusk.sysvars.clock;
    clock.slot = slot;
    clock.unix_timestamp = unix_timestamp;
    clock.epoch = mollusk.sysvars.epoch_schedule.get_epoch(slot);
    clock.leader_schedule_epoch = mollusk
        .sysvars
        .epoch_schedule
        .get_leader_schedule_epoch(slot);
}

pub fn advance(mollusk: &mut Mollusk, seconds: i64) {
    let slot = mollusk.sysvars.clock.slot as i64 + seconds * SLOTS_PER_2_SECONDS / 2;
    let unix_timestamp = mollusk.sysvars.clock.unix_timestamp + seconds;
    set_clock(mollusk, slot as u64, unix_timestamp);
}

pub fn now(mollusk: &Mollusk) -> i64 {
    mollusk.sysvars.clock.unix_timestamp
}

// ── Акаунти оточення ─────────────────────────────────────────────────────────

pub fn funded_wallet() -> Account {
    Account {
        lamports: 10 * LAMPORTS_PER_SOL,
        data: Vec::new(),
        owner: anchor_lang::system_program::ID,
        executable: false,
        rent_epoch: 0,
    }
}

/// Місце під акаунт, який створить сама програма: mollusk не заводить
/// акаунтів автоматично, і забутий рядок виглядає як помилка в програмі.
pub fn empty(key: Pubkey) -> (Pubkey, Account) {
    (key, Account::default())
}

pub fn system_program() -> (Pubkey, Account) {
    mollusk_svm::program::keyed_account_for_system_program()
}

pub fn token_program() -> (Pubkey, Account) {
    token2022::keyed_account()
}

pub fn ata_program() -> (Pubkey, Account) {
    associated_token::keyed_account()
}

/// Акаунт самої програми — у переказі з хуком він мусить бути серед акаунтів
/// інструкції, інакше Token-2022 не має куди робити CPI.
pub fn caprail_program() -> (Pubkey, Account) {
    (caprail::ID, create_program_account_loader_v3(&caprail::ID))
}

pub fn rent_exempt(mollusk: &Mollusk, data: Vec<u8>, owner: Pubkey) -> Account {
    Account {
        lamports: mollusk.sysvars.rent.minimum_balance(data.len()),
        data,
        owner,
        executable: false,
        rent_epoch: 0,
    }
}

// ── Token-2022 ───────────────────────────────────────────────────────────────

/// Розкладки мінта й токен-акаунта — з того самого `spl-token-2022-interface`,
/// що й у програмі (через `anchor_spl`), а не з будівельників mollusk: ті
/// тягнуть третю мажорну версію інтерфейсу, і перевірка розширень у хуку
/// звірялась би з іншим `ExtensionType`, ніж бачить тест.
fn mint_state(mint_authority: &Pubkey, supply: u64, decimals: u8) -> Mint {
    Mint {
        mint_authority: COption::Some(*mint_authority),
        supply,
        decimals,
        is_initialized: true,
        freeze_authority: COption::None,
    }
}

/// Mint компанії: розширення `TransferHook` вказує на `caprail`. Це та сама
/// форма, яку `create_token` збере в мережі, тож переказ через нього доходить
/// до `execute` рівно так само.
pub fn hook_mint(mollusk: &Mollusk, mint_authority: &Pubkey, supply: u64, decimals: u8) -> Account {
    let len = ExtensionType::try_calculate_account_len::<Mint>(&[ExtensionType::TransferHook])
        .expect("довжина мінта з TransferHook");
    let mut data = vec![0u8; len];
    {
        let mut state =
            StateWithExtensionsMut::<Mint>::unpack_uninitialized(&mut data).expect("порожній мінт");
        let hook = state
            .init_extension::<TransferHook>(true)
            .expect("TransferHook");
        hook.authority = OptionalNonZeroPubkey::try_from(Some(*mint_authority)).expect("authority");
        hook.program_id = OptionalNonZeroPubkey::try_from(Some(caprail::ID)).expect("program_id");
        state.base = mint_state(mint_authority, supply, decimals);
        state.pack_base();
        state.init_account_type().expect("тип акаунта");
    }
    rent_exempt(mollusk, data, spl_token_2022::ID)
}

/// Mint без розширень — контроль: переказ через нього до хука не доходить.
pub fn plain_mint(
    mollusk: &Mollusk,
    mint_authority: &Pubkey,
    supply: u64,
    decimals: u8,
) -> Account {
    let mut data = vec![0u8; Mint::LEN];
    {
        let mut state =
            StateWithExtensionsMut::<Mint>::unpack_uninitialized(&mut data).expect("порожній мінт");
        state.base = mint_state(mint_authority, supply, decimals);
        state.pack_base();
        state.init_account_type().expect("тип акаунта");
    }
    rent_exempt(mollusk, data, spl_token_2022::ID)
}

pub fn ata(owner: &Pubkey, mint: &Pubkey) -> Pubkey {
    get_associated_token_address_with_program_id(owner, mint, &spl_token_2022::ID)
}

fn token_account_state(mint: &Pubkey, owner: &Pubkey, amount: u64) -> TokenAccount {
    TokenAccount {
        mint: *mint,
        owner: *owner,
        amount,
        delegate: COption::None,
        state: AccountState::Initialized,
        is_native: COption::None,
        delegated_amount: 0,
        close_authority: COption::None,
    }
}

fn token_account_with(
    mollusk: &Mollusk,
    state_base: TokenAccount,
    extensions: &[ExtensionType],
) -> Account {
    let len = ExtensionType::try_calculate_account_len::<TokenAccount>(extensions)
        .expect("довжина токен-акаунта");
    let mut data = vec![0u8; len];
    {
        let mut state = StateWithExtensionsMut::<TokenAccount>::unpack_uninitialized(&mut data)
            .expect("порожній токен-акаунт");
        for extension in extensions {
            match extension {
                ExtensionType::ImmutableOwner => {
                    state
                        .init_extension::<ImmutableOwner>(true)
                        .expect("ImmutableOwner");
                }
                ExtensionType::TransferHookAccount => {
                    state
                        .init_extension::<TransferHookAccount>(true)
                        .expect("TransferHookAccount");
                }
                other => panic!("стенд не збирає розширення {other:?}"),
            }
        }
        state.base = state_base;
        state.pack_base();
        state.init_account_type().expect("тип акаунта");
    }
    rent_exempt(mollusk, data, spl_token_2022::ID)
}

/// Токен-акаунт у формі, яку створює ATA-програма під mint із хуком:
/// `ImmutableOwner` додає вона сама, `TransferHookAccount` вимагає mint —
/// без нього Token-2022 відхиляє переказ ще до виклику хука.
pub fn hook_token_account(
    mollusk: &Mollusk,
    mint: &Pubkey,
    owner: &Pubkey,
    amount: u64,
) -> Account {
    token_account_with(
        mollusk,
        token_account_state(mint, owner, amount),
        &[
            ExtensionType::ImmutableOwner,
            ExtensionType::TransferHookAccount,
        ],
    )
}

pub fn plain_token_account(
    mollusk: &Mollusk,
    mint: &Pubkey,
    owner: &Pubkey,
    amount: u64,
) -> Account {
    token_account_with(mollusk, token_account_state(mint, owner, amount), &[])
}

/// `transfer_checked` Token-2022 з додатковими акаунтами хука в хвості —
/// так само, як їх додає клієнт після `resolveExtraAccountMetas`.
pub fn transfer_checked(
    mint: &Pubkey,
    source: &Pubkey,
    destination: &Pubkey,
    authority: &Pubkey,
    amount: u64,
    decimals: u8,
    hook_accounts: &[AccountMeta],
) -> Instruction {
    let mut instruction = token_instruction::transfer_checked(
        &spl_token_2022::ID,
        source,
        mint,
        destination,
        authority,
        &[],
        amount,
        decimals,
    )
    .expect("transfer_checked");
    instruction.accounts.extend_from_slice(hook_accounts);
    instruction
}

// ── Читання результату ───────────────────────────────────────────────────────

pub fn account_of<'a>(result: &'a InstructionResult, key: &Pubkey) -> &'a Account {
    result
        .get_account(key)
        .unwrap_or_else(|| panic!("акаунт {key} має бути серед результатів інструкції"))
}

pub fn token_amount(result: &InstructionResult, key: &Pubkey) -> u64 {
    StateWithExtensions::<TokenAccount>::unpack(&account_of(result, key).data)
        .expect("токен-акаунт має читатися")
        .base
        .amount
}

/// Акаунт, який у мережі створила б сама програма: дискримінатор Anchor плюс
/// borsh-тіло. Дозволяє починати тест зі стану «компанія вже є», не проганяючи
/// попередню інструкцію заради її побічного ефекту.
pub fn anchor_account<T: Discriminator + AnchorSerialize>(mollusk: &Mollusk, state: &T) -> Account {
    let mut data = T::DISCRIMINATOR.to_vec();
    state
        .serialize(&mut data)
        .expect("стан має серіалізуватись");
    rent_exempt(mollusk, data, caprail::ID)
}

pub fn mint_base(account: &Account) -> Mint {
    StateWithExtensions::<Mint>::unpack(&account.data)
        .expect("мінт має читатися")
        .base
}

/// `None` означає відкликане право емісії — випуск зафіксований назавжди.
pub fn mint_authority_of(account: &Account) -> Option<Pubkey> {
    Option::from(mint_base(account).mint_authority)
}

/// Метадані живуть у самому мінті (`MetadataPointer` вказує на нього ж), тому
/// читаються як розширення змінної довжини.
pub fn mint_metadata(account: &Account) -> TokenMetadata {
    StateWithExtensions::<Mint>::unpack(&account.data)
        .expect("мінт має читатися")
        .get_variable_len_extension::<TokenMetadata>()
        .expect("TokenMetadata")
}

pub fn metadata_address_of(account: &Account) -> Option<Pubkey> {
    let state = StateWithExtensions::<Mint>::unpack(&account.data).expect("мінт має читатися");
    let pointer = state
        .get_extension::<MetadataPointer>()
        .expect("MetadataPointer");
    Option::from(pointer.metadata_address)
}

/// Програма хука з розширення мінта — `None`, якщо розширення немає або воно
/// порожнє (Token-2022 дозволяє `TransferHook` із нульовим `program_id`).
pub fn hook_program_of(mint: &Account) -> Option<Pubkey> {
    let state = StateWithExtensions::<Mint>::unpack(&mint.data).ok()?;
    let hook = state.get_extension::<TransferHook>().ok()?;
    Option::<Pubkey>::from(hook.program_id)
}

pub fn read<T: AccountDeserialize>(result: &InstructionResult, key: &Pubkey) -> T {
    T::try_deserialize(&mut account_of(result, key).data.as_slice()).expect("акаунт має читатися")
}

/// Код помилки з самого enum, а не з таблиці констант: додати помилку в
/// середину `errors.rs` — звичайна річ, а зсунуті вручну числа роблять тест,
/// який зеленіє на неправильній причині відмови.
pub fn expected(error: CaprailError) -> u32 {
    error.into()
}

/// Те саме для вбудованих кодів Anchor (`ConstraintSeeds`, `ConstraintOwner`).
pub fn anchor_code(error: anchor_lang::error::ErrorCode) -> u32 {
    error.into()
}

pub fn custom_error_code(result: &InstructionResult) -> Option<u32> {
    match &result.program_result {
        ProgramResult::Failure(ProgramError::Custom(code)) => Some(*code),
        _ => None,
    }
}

pub fn is_success(result: &InstructionResult) -> bool {
    result.program_result == ProgramResult::Success
}

// ── Події ────────────────────────────────────────────────────────────────────

/// Логи, накопичені з моменту створення стенду (або останнього `take_logs`).
///
/// Скидається ВЕСЬ збирач, не лише вектор повідомлень: ліміт у нього — 10 000
/// байтів на життя збирача, і `mem::take(messages)` лічильника не обнуляє.
/// Після ~14 переказів події мовчки зникали б, а набір SC-002 бачив би «0 подій»
/// на цілком дозволеному переказі.
pub fn take_logs(mollusk: &Mollusk) -> Vec<String> {
    let logger = mollusk.logger.as_ref().expect("стенд створює збирач логів");
    std::mem::take(&mut *logger.borrow_mut()).messages
}

/// Події з логів: `emit!` пише `Program data: <base64>`, де перші 8 байтів —
/// дискримінатор події. Порядок — як у логах, включно з подіями CPI.
pub fn events<T: Discriminator + AnchorDeserialize>(logs: &[String]) -> Vec<T> {
    logs.iter()
        .filter_map(|line| line.strip_prefix("Program data: "))
        .flat_map(|payload| payload.split(' '))
        .map(|chunk| BASE64.decode(chunk).expect("base64 у Program data"))
        .filter(|bytes| bytes.starts_with(T::DISCRIMINATOR))
        .map(|bytes| {
            T::try_from_slice(&bytes[T::DISCRIMINATOR.len()..]).expect("подія має читатися")
        })
        .collect()
}
