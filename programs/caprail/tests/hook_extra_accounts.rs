//! `ExtraAccountMetaList` (T018): чотири seed-конфіги, які Token-2022 резолвить
//! на кожному переказі.
//!
//! Тест резолвить їх тією самою бібліотекою, що й токен-програма
//! (`spl-tlv-account-resolution`), і звіряє з адресами, які виводить решта
//! програми. Помилка в `address_config` інакше знайшлася б аж на першому
//! переказі — і виглядала б як «акаунта немає», тобто «не допущений».

mod common;

use anchor_lang::prelude::Pubkey;
use caprail::hook::{extra_account_metas, EXTRA_ACCOUNT_COUNT, EXTRA_ACCOUNT_METAS_SEED};
use caprail::state::{InvestorRecord, TokenConfig, GRANT_SEED, PERMIT_SEED};
use common::*;
use solana_account::Account;
use spl_tlv_account_resolution::state::ExtraAccountMetaList;
use spl_transfer_hook_interface::get_extra_account_metas_address;
use spl_transfer_hook_interface::instruction::ExecuteInstruction;

/// Акаунти інструкції `Execute` у порядку, який задає інтерфейс хука.
struct ExecuteAccounts {
    source: Pubkey,
    mint: Pubkey,
    destination: Pubkey,
    owner: Pubkey,
    list: Pubkey,
    source_data: Account,
    destination_data: Account,
}

impl ExecuteAccounts {
    fn new(mollusk: &mollusk_svm::Mollusk, seller: &Pubkey, buyer: &Pubkey) -> Self {
        let mint = Pubkey::new_unique();
        Self {
            source: ata(seller, &mint),
            mint,
            destination: ata(buyer, &mint),
            owner: *seller,
            list: get_extra_account_metas_address(&mint, &caprail::ID),
            source_data: hook_token_account(mollusk, &mint, seller, 100),
            destination_data: hook_token_account(mollusk, &mint, buyer, 0),
        }
    }

    fn key_data(&self, index: usize) -> Option<(&Pubkey, Option<&[u8]>)> {
        match index {
            0 => Some((&self.source, Some(self.source_data.data.as_slice()))),
            1 => Some((&self.mint, None)),
            2 => Some((
                &self.destination,
                Some(self.destination_data.data.as_slice()),
            )),
            3 => Some((&self.owner, None)),
            4 => Some((&self.list, None)),
            _ => None,
        }
    }
}

/// Адреси беруться зі зрізів даних токен-акаунтів, тому резолюція має дати
/// рівно ті PDA, які виводить програма за тими самими гаманцями.
#[test]
fn resolves_to_the_pdas_the_program_derives() {
    let mollusk = mollusk();
    let seller = Pubkey::new_unique();
    let buyer = Pubkey::new_unique();
    let accounts = ExecuteAccounts::new(&mollusk, &seller, &buyer);
    let metas = extra_account_metas().expect("список акаунтів хука");
    assert_eq!(metas.len(), EXTRA_ACCOUNT_COUNT);

    let expected = [
        TokenConfig::find_address(&accounts.mint).0,
        InvestorRecord::find_address(&accounts.mint, &buyer).0,
        Pubkey::find_program_address(
            &[GRANT_SEED, accounts.mint.as_ref(), seller.as_ref()],
            &caprail::ID,
        )
        .0,
        Pubkey::find_program_address(&[PERMIT_SEED, accounts.source.as_ref()], &caprail::ID).0,
    ];

    for (meta, expected) in metas.iter().zip(expected) {
        let resolved = meta
            .resolve(&[], &caprail::ID, |index| accounts.key_data(index))
            .expect("seed-конфіг має резолвитись");
        assert_eq!(resolved.pubkey, expected);
        // Хук тільки читає: жоден із цих акаунтів не підписує і не змінюється.
        assert!(!resolved.is_signer);
        assert!(!resolved.is_writable);
    }
}

/// `InvestorRecord` береться за ОДЕРЖУВАЧЕМ, а `Grant` — за ВІДПРАВНИКОМ.
/// Переставлені місцями зрізи дали б хук, який перевіряє допуск не того боку,
/// і всі тести правила лишалися б зеленими.
#[test]
fn reads_the_recipient_for_admission_and_the_sender_for_vesting() {
    let mollusk = mollusk();
    let seller = Pubkey::new_unique();
    let buyer = Pubkey::new_unique();
    let accounts = ExecuteAccounts::new(&mollusk, &seller, &buyer);
    let metas = extra_account_metas().expect("список акаунтів хука");

    let record = metas[1]
        .resolve(&[], &caprail::ID, |index| accounts.key_data(index))
        .expect("InvestorRecord")
        .pubkey;
    assert_eq!(
        record,
        InvestorRecord::find_address(&accounts.mint, &buyer).0
    );
    assert_ne!(
        record,
        InvestorRecord::find_address(&accounts.mint, &seller).0
    );

    let grant = metas[2]
        .resolve(&[], &caprail::ID, |index| accounts.key_data(index))
        .expect("Grant")
        .pubkey;
    assert_eq!(
        grant,
        Pubkey::find_program_address(
            &[GRANT_SEED, accounts.mint.as_ref(), seller.as_ref()],
            &caprail::ID
        )
        .0
    );
}

/// Наш літерал seed проти константи інтерфейсу, яка не публічна: якщо вони
/// розійдуться, токен-програма шукатиме список за іншою адресою і хук не
/// отримає жодного додаткового акаунта.
#[test]
fn extra_account_metas_pda_matches_the_interface() {
    let mint = Pubkey::new_unique();
    assert_eq!(
        Pubkey::find_program_address(&[EXTRA_ACCOUNT_METAS_SEED, mint.as_ref()], &caprail::ID).0,
        get_extra_account_metas_address(&mint, &caprail::ID)
    );
}

/// Список у створеному токені — байт у байт той, що оголошений у програмі.
/// Разом із резолюцією вище це закриває шлях «оголосили одне, записали інше».
#[test]
fn the_stored_list_is_exactly_the_declared_one() {
    let mut expected = vec![
        0u8;
        ExtraAccountMetaList::size_of(EXTRA_ACCOUNT_COUNT)
            .expect("розмір списку")
    ];
    ExtraAccountMetaList::init::<ExecuteInstruction>(
        &mut expected,
        &extra_account_metas().expect("список акаунтів хука"),
    )
    .expect("список має пакуватись");

    assert_eq!(created_token_extra_metas(), expected);
}

/// Створює токен так само, як тест T017, і повертає байти записаного списку.
fn created_token_extra_metas() -> Vec<u8> {
    use anchor_lang::{InstructionData, ToAccountMetas};
    use anchor_spl::token_2022::spl_token_2022;
    use caprail::instructions::CreateTokenArgs;
    use caprail::state::{Company, TransferPolicy};
    use solana_instruction::Instruction;

    let mollusk = mollusk();
    let admin = Pubkey::new_unique();
    let (company, company_bump) = Company::find_address(1);
    let (mint, _) = TokenConfig::find_mint_address(&company, 0);
    let (token_config, _) = TokenConfig::find_address(&mint);
    let treasury = ata(&company, &mint);
    let list = get_extra_account_metas_address(&mint, &caprail::ID);

    let state = Company {
        company_id: 1,
        admin,
        compliance_officer: Pubkey::new_unique(),
        name: [b'x'; Company::NAME_LEN],
        token_count: 0,
        bump: company_bump,
    };
    let instruction = Instruction {
        program_id: caprail::ID,
        accounts: caprail::accounts::CreateToken {
            admin,
            company,
            mint,
            token_config,
            treasury,
            extra_account_meta_list: list,
            token_program: spl_token_2022::ID,
            associated_token_program: anchor_spl::associated_token::ID,
            system_program: anchor_lang::system_program::ID,
        }
        .to_account_metas(None),
        data: caprail::instruction::CreateToken {
            args: CreateTokenArgs {
                name: "Acme".to_string(),
                symbol: "ACME".to_string(),
                uri: String::new(),
                decimals: 0,
                total_supply: 1,
                policy: TransferPolicy {
                    require_accreditation: true,
                    require_rofr: false,
                    rofr_window_secs: 0,
                },
            },
        }
        .data(),
    };

    let result = mollusk.process_instruction(
        &instruction,
        &[
            (admin, funded_wallet()),
            (company, anchor_account(&mollusk, &state)),
            empty(mint),
            empty(token_config),
            empty(treasury),
            empty(list),
            token_program(),
            ata_program(),
            system_program(),
        ],
    );
    assert!(is_success(&result), "{:?}", result.program_result);
    account_of(&result, &list).data.clone()
}
