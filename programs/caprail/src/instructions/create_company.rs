use anchor_lang::prelude::*;

use crate::errors::CaprailError;
use crate::events::CompanyCreated;
use crate::state::Company;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct CreateCompanyArgs {
    // Обирає клієнт; зайнятий id дає відмову `init`, а не перезапис.
    pub company_id: u64,
    pub compliance_officer: Pubkey,
    // До 32 байтів UTF-8 — стільки вміщає `Company::name`.
    pub name: String,
}

#[derive(Accounts)]
#[instruction(args: CreateCompanyArgs)]
pub struct CreateCompany<'info> {
    // Той, хто підписує, і є адміністратором: окремого «власника» немає.
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        init,
        payer = admin,
        space = Company::SPACE,
        seeds = [Company::SEED, &args.company_id.to_le_bytes()],
        bump,
    )]
    pub company: Account<'info, Company>,
    pub system_program: Program<'info, System>,
}

pub fn create_company_handler(ctx: Context<CreateCompany>, args: CreateCompanyArgs) -> Result<()> {
    let name = args.name.as_bytes();
    require!(
        !name.is_empty() && name.len() <= Company::NAME_LEN,
        CaprailError::InvalidName
    );
    let admin = ctx.accounts.admin.key();
    Company::validate_roles(&admin, &args.compliance_officer)?;

    let company = &mut ctx.accounts.company;
    company.company_id = args.company_id;
    company.admin = admin;
    company.compliance_officer = args.compliance_officer;
    company.name = [0u8; Company::NAME_LEN];
    company.name[..name.len()].copy_from_slice(name);
    company.token_count = 0;
    company.bump = ctx.bumps.company;

    emit!(CompanyCreated {
        company: company.key(),
        company_id: args.company_id,
        admin,
        compliance_officer: args.compliance_officer,
        name: args.name,
    });
    Ok(())
}
