//! Стенд хука: стан «токен випущено» і переказ через нього.
//!
//! Лежить окремо від тестів правила (`hook_admission.rs`), бо ті самі перекази
//! потрібні і CU-гейту (`hook_cu.rs`): випадок, який стереже бюджет, мусить
//! бути тим самим випадком, який доводить правило, — інакше гейт міряє щось
//! своє, і зелене число нічого не каже про переказ, який іде в мережу.
//!
//! Спільний стенд обох програм (`common`) підключає кореневий файл тесту;
//! звідси він видимий як `crate::common`.

#![allow(dead_code)]

use crate::common::*;
use anchor_lang::prelude::Pubkey;
use caprail::events::TransferAllowed;
use caprail::hook::{extra_account_metas, EXTRA_ACCOUNT_COUNT, HOOK_PROGRAM_ID};
use caprail::state::{
    Company, InvestorRecord, InvestorStatus, TokenConfig, TransferPolicy, GRANT_SEED, PERMIT_SEED,
};
use mollusk_svm::result::InstructionResult;
use mollusk_svm::Mollusk;
use solana_account::Account;
use solana_instruction::{AccountMeta, Instruction};
use spl_tlv_account_resolution::state::ExtraAccountMetaList;
use spl_transfer_hook_interface::get_extra_account_metas_address;
use spl_transfer_hook_interface::instruction::ExecuteInstruction;

pub const COMPANY_ID: u64 = 7;
pub const SUPPLY: u64 = 1_000_000;
pub const YEAR: i64 = 365 * 24 * 60 * 60;

pub fn accreditation_policy(require_accreditation: bool) -> TransferPolicy {
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
pub struct Token {
    pub company: Pubkey,
    pub mint: Pubkey,
    pub token_config: Pubkey,
    pub list: Pubkey,
    pub accounts: Vec<(Pubkey, Account)>,
}

pub fn token(mollusk: &Mollusk, policy: TransferPolicy) -> Token {
    let (company, company_bump) = Company::find_address(COMPANY_ID);
    let (mint, _) = TokenConfig::find_mint_address(&company, 0);
    let (token_config, config_bump) = TokenConfig::find_address(&mint);
    let list = get_extra_account_metas_address(&mint, &HOOK_PROGRAM_ID);

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
            (list, rent_exempt(mollusk, list_data, HOOK_PROGRAM_ID)),
            (company, anchor_account(mollusk, &company_state)),
            caprail_program(),
            hook_program(),
        ],
    }
}

/// Запис реєстру одержувача або його відсутність — той стан, який хук
/// застане в мережі.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Registry {
    NoRecord,
    Record(InvestorStatus, i64),
}

impl Registry {
    pub fn approved_until(expires_at: i64) -> Self {
        Self::Record(InvestorStatus::Approved, expires_at)
    }

    pub fn account(self, mollusk: &Mollusk, token: &Token, wallet: &Pubkey) -> (Pubkey, Account) {
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
pub struct Transfer {
    pub source: Pubkey,
    pub destination: Pubkey,
    pub instruction: Instruction,
    pub accounts: Vec<(Pubkey, Account)>,
}

pub fn transfer(
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
        caprail::ID,
        token.token_config,
        record,
        grant,
        permit,
        token.list,
        HOOK_PROGRAM_ID,
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

pub fn run(mollusk: &Mollusk, transfer: &Transfer) -> InstructionResult {
    mollusk.process_instruction(&transfer.instruction, &transfer.accounts)
}

/// Дозволені перекази цієї спроби — з логів, накопичених від попереднього виклику.
pub fn allowed(mollusk: &Mollusk) -> Vec<TransferAllowed> {
    events::<TransferAllowed>(&take_logs(mollusk))
}
