use anchor_lang::prelude::*;

use super::{DISCRIMINATOR_LEN, GRANT_SEED};
use crate::vesting::vested;

// A vesting grant (FR-010), one per (mint, wallet): the hook finds it by the
// sender's wallet alone, so a second grant to the same wallet would need a
// different address scheme. Created only by `create_grant`; the hook reads it.
#[account]
#[derive(InitSpace)]
pub struct Grant {
    pub mint: Pubkey,
    pub wallet: Pubkey,
    pub total: u64,
    pub start_at: i64,
    pub cliff_at: i64,
    pub end_at: i64,
    pub bump: u8,
}

impl Grant {
    pub const SEED: &'static [u8] = GRANT_SEED;
    pub const SPACE: usize = DISCRIMINATOR_LEN + Self::INIT_SPACE;

    pub fn find_address(mint: &Pubkey, wallet: &Pubkey) -> (Pubkey, u8) {
        Pubkey::find_program_address(&[Self::SEED, mint.as_ref(), wallet.as_ref()], &crate::ID)
    }

    pub fn vested(&self, now: i64) -> Option<u64> {
        vested(self.total, self.start_at, self.cliff_at, self.end_at, now)
    }
}
