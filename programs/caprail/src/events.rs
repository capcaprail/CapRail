//! Anchor-події — єдине, що читає індекс (worker). Він не дивиться на акаунти
//! транзакції, тому кожна подія несе все, що потрібно для рядка в БД.

use anchor_lang::prelude::*;

use crate::state::{InvestorStatus, TransferPolicy};

// Один раз на розгортання програми: комісія і стейблкоїн оплати. Індекс бере
// їх звідси, щоб API показував сторонам число до прийняття (FR-013), не
// дочитуючи акаунт із вузла.
#[event]
pub struct PlatformInitialized {
    pub platform: Pubkey,
    pub authority: Pubkey,
    pub payment_mint: Pubkey,
    pub fee_treasury: Pubkey,
    pub fee_bps: u16,
    pub initialized_at: i64,
}

#[event]
pub struct CompanyCreated {
    pub company: Pubkey,
    pub company_id: u64,
    pub admin: Pubkey,
    pub compliance_officer: Pubkey,
    pub name: String,
}

// Єдине, з чого worker дізнається про новий mint: акаунтів транзакції він не
// читає. Тому тут і казначейство, і початкова політика.
#[event]
pub struct TokenCreated {
    pub company: Pubkey,
    pub mint: Pubkey,
    pub treasury: Pubkey,
    pub name: String,
    pub symbol: String,
    pub decimals: u8,
    pub total_supply: u64,
    pub policy: TransferPolicy,
    pub policy_version: u32,
}

// Історія політики в індексі ведеться по `policy_version`; `set_at` тут, щоб
// рядок історії не залежав від `block_time` транзакції.
#[event]
pub struct PolicySet {
    pub company: Pubkey,
    pub mint: Pubkey,
    pub policy: TransferPolicy,
    pub policy_version: u32,
    pub set_at: i64,
}

#[event]
pub struct RolesSet {
    pub company: Pubkey,
    pub admin: Pubkey,
    pub compliance_officer: Pubkey,
    pub set_at: i64,
}

// Емітить хук `execute` на кожному дозволеному переказі — і з `distribute`,
// і зі стороннього гаманця: інакше прямі перекази між інвесторами не потрапили
// б у журнал (FR-008). Гаманці обох сторін тут, а не лише токен-рахунки, щоб
// worker не дочитував акаунти з RPC; `policy_version` — яка політика пропустила.
#[event]
pub struct TransferAllowed {
    pub company: Pubkey,
    pub mint: Pubkey,
    pub source: Pubkey,
    pub destination: Pubkey,
    pub source_owner: Pubkey,
    pub destination_owner: Pubkey,
    pub amount: u64,
    // Джерело частки для cap table: розподіл із казначейства чи переказ між
    // держателями.
    pub from_treasury: bool,
    pub policy_version: u32,
}

// Реєстр інвесторів індекс веде лише з цієї події: і поточний стан
// (`investors`), і історію (`investor_status_events`) — звідси ж `updated_by`.
#[event]
pub struct InvestorStatusSet {
    pub company: Pubkey,
    pub mint: Pubkey,
    pub wallet: Pubkey,
    pub status: InvestorStatus,
    pub expires_at: i64,
    pub jurisdiction: [u8; 2],
    pub investor_type: u8,
    pub updated_at: i64,
    pub updated_by: Pubkey,
}

// Нова пропозиція на ринку. `company` — щоб індекс поклав рядок під тенанта без
// пошуку мінта; `payment_mint` — у чому ціна, бо платформу можна розгорнути з
// будь-яким стейблкоїном. Ціна — за мінімальну одиницю токена.
#[event]
pub struct OfferCreated {
    pub offer: Pubkey,
    pub company: Pubkey,
    pub mint: Pubkey,
    pub seller: Pubkey,
    pub offer_id: u64,
    pub amount: u64,
    pub price_per_unit: u64,
    pub payment_mint: Pubkey,
    pub rofr_until: i64,
    pub created_at: i64,
}

// `remaining` — скільки лишилось непроданим на момент скасування. Якщо
// делегування вже було не наше (`delegation_revoked = false`), рахунок продавця
// лишився з чужим делегатом — індексу це пояснює, чому пропозиція була `stale`.
#[event]
pub struct OfferCancelled {
    pub offer: Pubkey,
    pub mint: Pubkey,
    pub seller: Pubkey,
    pub offer_id: u64,
    pub remaining: u64,
    pub delegation_revoked: bool,
    pub cancelled_at: i64,
}

// Угода — прийняття цілком або частково. Сторони й суми тут цілком, щоб індекс
// поклав рядок у `trades`, а cap table позначив частку покупця джерелом
// «покупка», не дочитуючи транзакцію; сам переказ частки журнал бачить ще й
// як `TransferAllowed` від хука. `payment` — уся оплата, продавець отримав
// `payment − fee`; `remaining == 0` — пропозиція виконана.
#[event]
pub struct OfferAccepted {
    pub offer: Pubkey,
    pub company: Pubkey,
    pub mint: Pubkey,
    pub seller: Pubkey,
    pub buyer: Pubkey,
    pub offer_id: u64,
    pub amount: u64,
    pub price_per_unit: u64,
    pub payment: u64,
    pub fee: u64,
    pub payment_mint: Pubkey,
    pub remaining: u64,
    pub accepted_at: i64,
}
