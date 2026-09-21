use anchor_lang::prelude::*;

use super::DISCRIMINATOR_LEN;

// Стан пропозиції. «У вікні ROFR» зі спеки — похідне `Open ∧ rofr_until > now`,
// окремого значення немає: інакше хтось мусив би виконати транзакцію, щоб
// перевести акаунт із «у вікні» в «відкрита», коли час просто минув.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub enum OfferStatus {
    Open,
    Filled,
    Cancelled,
}

// Пропозиція продажу на вторинному ринку (FR-011). Токени лишаються в
// продавця: ескроу під PDA хук відхилив би як «не допущеного», тож `create_offer`
// ставить цей PDA делегатом на `amount` (`approve_checked`), а `accept_offer`
// переказує делегатом через хук. Продавець, що зняв делегування або переказав
// токени, робить пропозицію невиконуваною — індекс показує це як `stale`.
#[account]
#[derive(InitSpace)]
pub struct Offer {
    pub mint: Pubkey,
    pub seller: Pubkey,
    // Обирає продавець (як `company_id`): один гаманець тримає кілька
    // пропозицій на той самий mint під різними id.
    pub offer_id: u64,
    // Виставлено спочатку — не змінюється; історія угоди рахується від нього.
    pub amount: u64,
    // Скільки ще можна купити; часткове прийняття зменшує, нуль = `Filled`.
    pub remaining: u64,
    // Ціна за одну мінімальну одиницю токена в мінімальних одиницях
    // `payment_mint`: оплата = `amount × price_per_unit` без ділення, тож
    // часткове прийняття не лишає залишків від округлення.
    pub price_per_unit: u64,
    // Unix-час закриття вікна ROFR; 0 — вікна не було (політика без ROFR).
    pub rofr_until: i64,
    pub status: OfferStatus,
    pub created_at: i64,
    pub bump: u8,
}

impl Offer {
    pub const SEED: &'static [u8] = b"offer";
    pub const SPACE: usize = DISCRIMINATOR_LEN + Self::INIT_SPACE;

    pub fn find_address(mint: &Pubkey, seller: &Pubkey, offer_id: u64) -> (Pubkey, u8) {
        Pubkey::find_program_address(
            &[
                Self::SEED,
                mint.as_ref(),
                seller.as_ref(),
                &offer_id.to_le_bytes(),
            ],
            &crate::ID,
        )
    }

    // Спільна перевірка для `create_offer`: нульова кількість чи ціна — не
    // пропозиція, а помилка вводу; оплата за весь `amount` мусить вміщатися в u64,
    // інакше часткове прийняття на межі впало б на переповненні вже в покупця.
    pub fn validate_terms(amount: u64, price_per_unit: u64) -> Result<()> {
        require!(
            amount > 0 && price_per_unit > 0,
            crate::CaprailError::InvalidOffer
        );
        require!(
            amount.checked_mul(price_per_unit).is_some(),
            crate::CaprailError::InvalidOffer
        );
        Ok(())
    }

    pub fn is_open(&self) -> bool {
        self.status == OfferStatus::Open
    }

    // Поки вікно відкрите, прийняти може лише казначейство через `accept_rofr`
    // (FR-014); після — будь-який допущений покупець.
    pub fn in_rofr_window(&self, now: i64) -> bool {
        self.is_open() && self.rofr_until > now
    }

    // Оплата за `amount` одиниць за умовами цієї пропозиції. `validate_terms`
    // гарантує, що добуток на повний `amount` вміщається, тож на частині
    // `None` можливий лише для `amount` понад виставлене.
    pub fn payment_for(&self, amount: u64) -> Option<u64> {
        if amount == 0 || amount > self.remaining {
            return None;
        }
        amount.checked_mul(self.price_per_unit)
    }
}
