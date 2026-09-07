use anchor_lang::prelude::*;

use crate::errors::CaprailError;
use crate::events::InvestorStatusSet;
use crate::state::{Company, InvestorRecord, InvestorStatus, TokenConfig};

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct SetInvestorStatusArgs {
    pub wallet: Pubkey,
    pub status: InvestorStatus,
    // Хук вимагає `expires_at > now`; для `None` і `Revoked` значення довідкове.
    pub expires_at: i64,
    // ISO 3166-1 alpha-2 або нулі. Довідкове поле для звітів: переказ по ньому
    // не блокується (FR-002).
    pub jurisdiction: [u8; 2],
    pub investor_type: u8,
}

impl SetInvestorStatusArgs {
    fn validate(&self, now: i64) -> Result<()> {
        let unset = self.jurisdiction == [0, 0];
        let letters = self.jurisdiction.iter().all(|b| b.is_ascii_uppercase());
        require!(unset || letters, CaprailError::InvalidJurisdiction);
        // Запис, який народжується простроченим, — помилка вводу, а не статус:
        // хук відхилив би переказ на нього з першої ж секунди.
        require!(
            self.status != InvestorStatus::Approved || self.expires_at > now,
            CaprailError::InvalidExpiry
        );
        Ok(())
    }
}

#[derive(Accounts)]
#[instruction(args: SetInvestorStatusArgs)]
pub struct SetInvestorStatus<'info> {
    #[account(mut)]
    pub compliance_officer: Signer<'info>,
    // Статуси допуску ставить лише комплаєнс-офіцер; адміністратор не може
    // (FR-004), і це перевіряє зв'язок, а не інтерфейс.
    #[account(has_one = compliance_officer @ CaprailError::Unauthorized)]
    pub company: Account<'info, Company>,
    #[account(has_one = company @ CaprailError::Unauthorized)]
    pub token_config: Account<'info, TokenConfig>,
    // Перший статус створює запис, наступні — оновлюють. Хук акаунтів не
    // створює, тож без цієї інструкції гаманець просто «не допущений».
    #[account(
        init_if_needed,
        payer = compliance_officer,
        space = InvestorRecord::SPACE,
        seeds = [
            InvestorRecord::SEED,
            token_config.mint.as_ref(),
            args.wallet.as_ref(),
        ],
        bump,
    )]
    pub investor_record: Account<'info, InvestorRecord>,
    pub system_program: Program<'info, System>,
}

pub fn set_investor_status_handler(
    ctx: Context<SetInvestorStatus>,
    args: SetInvestorStatusArgs,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    args.validate(now)?;

    let officer = ctx.accounts.compliance_officer.key();
    let mint = ctx.accounts.token_config.mint;
    let record = &mut ctx.accounts.investor_record;
    record.mint = mint;
    record.wallet = args.wallet;
    record.status = args.status;
    record.expires_at = args.expires_at;
    record.jurisdiction = args.jurisdiction;
    record.investor_type = args.investor_type;
    record.updated_at = now;
    record.updated_by = officer;
    record.bump = ctx.bumps.investor_record;

    emit!(InvestorStatusSet {
        company: ctx.accounts.company.key(),
        mint,
        wallet: args.wallet,
        status: args.status,
        expires_at: args.expires_at,
        jurisdiction: args.jurisdiction,
        investor_type: args.investor_type,
        updated_at: now,
        updated_by: officer,
    });
    Ok(())
}
