//! `ExtraAccountMetaList` — акаунти, які Token-2022 додасть до кожного
//! `transfer_checked` цього мінта, щоб хук мав що читати.
//!
//! **Список пишеться один раз, у `create_token`, і живе стільки ж, скільки
//! токен.** Тому тут одразу всі чотири акаунти, включно з `Grant` (US3) і
//! `TransferPermit` (US2), яких ще немає: інакше vesting і ROFR вимагали б
//! перевипуску вже створених токенів.
//!
//! Адреси виводяться із seeds, а не зашиті ключами: `address_config` — 32
//! байти на конфіг, і pubkey-літерал разом із рештою seeds туди не влазить.
//! Гаманець одержувача й відправника беруться зрізом даних токен-акаунта
//! (`owner` — байти 32..64 розкладки Token-2022).

use anchor_lang::prelude::*;
use spl_tlv_account_resolution::account::ExtraAccountMeta;
use spl_tlv_account_resolution::seeds::Seed;

use crate::state::{InvestorRecord, TokenConfig, GRANT_SEED, PERMIT_SEED};

// Seed списку — з інтерфейсу хука, але константа там приватна. Тест
// `extra_account_metas_pda_matches_the_interface` тримає наш літерал
// зіставленим із `get_extra_account_metas_address`.
pub const EXTRA_ACCOUNT_METAS_SEED: &[u8] = b"extra-account-metas";

/// Скільки акаунтів хук просить додатково. Від цього числа рахується розмір
/// PDA у `create_token`.
pub const EXTRA_ACCOUNT_COUNT: usize = 4;

// Позиції акаунтів у самій інструкції `Execute` (їх задає інтерфейс хука):
// 0 — токен-акаунт джерела, 1 — мінт, 2 — токен-акаунт одержувача,
// 3 — власник джерела, 4 — цей список. Далі йдуть додаткові.
const SOURCE_INDEX: u8 = 0;
const MINT_INDEX: u8 = 1;
const DESTINATION_INDEX: u8 = 2;

// Зріз `owner` у розкладці токен-акаунта Token-2022: mint [0..32], owner [32..64].
const TOKEN_ACCOUNT_OWNER_OFFSET: u8 = 32;
const PUBKEY_LEN: u8 = 32;

/// Порядок сталий: хук читає їх за індексами, і переставити місцями — це
/// змінити сенс уже випущених токенів.
pub fn extra_account_metas() -> Result<Vec<ExtraAccountMeta>> {
    let metas = vec![
        // 5 — `TokenConfig` мінта: політика, версія, казначейство.
        ExtraAccountMeta::new_with_seeds(
            &[
                Seed::Literal {
                    bytes: TokenConfig::SEED.to_vec(),
                },
                Seed::AccountKey { index: MINT_INDEX },
            ],
            false,
            false,
        )?,
        // 6 — `InvestorRecord` одержувача: допуск і його строк.
        ExtraAccountMeta::new_with_seeds(
            &[
                Seed::Literal {
                    bytes: InvestorRecord::SEED.to_vec(),
                },
                Seed::AccountKey { index: MINT_INDEX },
                Seed::AccountData {
                    account_index: DESTINATION_INDEX,
                    data_index: TOKEN_ACCOUNT_OWNER_OFFSET,
                    length: PUBKEY_LEN,
                },
            ],
            false,
            false,
        )?,
        // 7 — `Grant` відправника: невестований залишок (US3).
        ExtraAccountMeta::new_with_seeds(
            &[
                Seed::Literal {
                    bytes: GRANT_SEED.to_vec(),
                },
                Seed::AccountKey { index: MINT_INDEX },
                Seed::AccountData {
                    account_index: SOURCE_INDEX,
                    data_index: TOKEN_ACCOUNT_OWNER_OFFSET,
                    length: PUBKEY_LEN,
                },
            ],
            false,
            false,
        )?,
        // 8 — `TransferPermit`: доказ, що переказ іде через пропозицію (US2).
        // Seed — сам токен-акаунт джерела, а не його власник: дозвіл живе одну
        // інструкцію і прив'язаний до конкретного рахунку.
        ExtraAccountMeta::new_with_seeds(
            &[
                Seed::Literal {
                    bytes: PERMIT_SEED.to_vec(),
                },
                Seed::AccountKey {
                    index: SOURCE_INDEX,
                },
            ],
            false,
            false,
        )?,
    ];
    Ok(metas)
}
