use anchor_lang::prelude::*;

use crate::errors::CaprailError;
use crate::events::RolesSet;
use crate::state::Company;

#[derive(Accounts)]
pub struct SetRoles<'info> {
    pub admin: Signer<'info>,
    #[account(mut, has_one = admin @ CaprailError::Unauthorized)]
    pub company: Account<'info, Company>,
}

// Обидві ролі змінні, і адміністратор передає свою тією ж інструкцією: зміна
// людини і ротація скомпрометованого ключа — те саме за механікою. Ціна —
// помилкова адреса лишає компанію без адміна назавжди, тому ключі проходять ту
// саму перевірку, що й при створенні.
pub fn set_roles_handler(
    ctx: Context<SetRoles>,
    admin: Pubkey,
    compliance_officer: Pubkey,
) -> Result<()> {
    Company::validate_roles(&admin, &compliance_officer)?;

    let company = &mut ctx.accounts.company;
    company.admin = admin;
    company.compliance_officer = compliance_officer;

    emit!(RolesSet {
        company: company.key(),
        admin,
        compliance_officer,
        set_at: Clock::get()?.unix_timestamp,
    });
    Ok(())
}
