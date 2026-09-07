use anchor_lang::prelude::*;
use anchor_lang::system_program::{transfer, Transfer};
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token_2022_extensions::spl_token_metadata_interface::state::TokenMetadata;
use anchor_spl::token_interface::{
    mint_to, set_authority, spl_token_2022::instruction::AuthorityType, token_metadata_initialize,
    Mint, MintTo, SetAuthority, TokenAccount, TokenInterface, TokenMetadataInitialize,
};
use spl_pod::optional_keys::OptionalNonZeroPubkey;
use spl_tlv_account_resolution::state::ExtraAccountMetaList;
use spl_transfer_hook_interface::instruction::ExecuteInstruction;

use crate::errors::CaprailError;
use crate::events::TokenCreated;
use crate::hook::{extra_account_metas, EXTRA_ACCOUNT_COUNT, EXTRA_ACCOUNT_METAS_SEED};
use crate::state::{Company, TokenConfig, TransferPolicy};

pub const TOKEN_NAME_MAX: usize = 32;
pub const TOKEN_SYMBOL_MAX: usize = 10;
pub const TOKEN_URI_MAX: usize = 200;
pub const DECIMALS_MAX: u8 = 9;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct CreateTokenArgs {
    pub name: String,
    pub symbol: String,
    // Може бути порожнім: гаманець покаже назву й символ і без посилання.
    pub uri: String,
    pub decimals: u8,
    pub total_supply: u64,
    pub policy: TransferPolicy,
}

impl CreateTokenArgs {
    fn validate(&self) -> Result<()> {
        // `len()` рядка — байти, а не символи; межі всюди в байтах.
        let name = self.name.len();
        require!(
            name > 0 && name <= TOKEN_NAME_MAX,
            CaprailError::InvalidName
        );
        let symbol = self.symbol.len();
        require!(
            symbol > 0 && symbol <= TOKEN_SYMBOL_MAX && self.uri.len() <= TOKEN_URI_MAX,
            CaprailError::InvalidMetadata
        );
        require!(
            self.total_supply > 0 && self.decimals <= DECIMALS_MAX,
            CaprailError::InvalidSupply
        );
        self.policy.validate()
    }
}

#[derive(Accounts)]
#[instruction(args: CreateTokenArgs)]
pub struct CreateToken<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    // Канонічність PDA перевіряти нічим не треба: акаунт із дискримінатором
    // `Company` під нашим власником міг створити лише `create_company`, а він
    // кладе його рівно за seeds. Роль — `has_one`.
    #[account(mut, has_one = admin @ CaprailError::Unauthorized)]
    pub company: Box<Account<'info, Company>>,
    // Розширення ставляться до `InitializeMint`, тому їх задає сам `init`;
    // `freeze_authority` не задаємо навмисно — заморожування рахунків не
    // входить у політику, правило виконує хук.
    #[account(
        init,
        payer = admin,
        seeds = [
            TokenConfig::MINT_SEED,
            company.key().as_ref(),
            &company.token_count.to_le_bytes(),
        ],
        bump,
        mint::decimals = args.decimals,
        mint::authority = company,
        mint::token_program = token_program,
        extensions::transfer_hook::program_id = crate::ID,
        extensions::transfer_hook::authority = company,
        extensions::metadata_pointer::metadata_address = mint,
        extensions::metadata_pointer::authority = company,
    )]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(
        init,
        payer = admin,
        space = TokenConfig::SPACE,
        seeds = [TokenConfig::SEED, mint.key().as_ref()],
        bump,
    )]
    pub token_config: Box<Account<'info, TokenConfig>>,
    // Казначейство — ATA під `Company` PDA: увесь випуск лягає сюди, а звідти
    // йде `distribute` через хук.
    #[account(
        init_if_needed,
        payer = admin,
        associated_token::mint = mint,
        associated_token::authority = company,
        associated_token::token_program = token_program,
    )]
    pub treasury: Box<InterfaceAccount<'info, TokenAccount>>,
    // Адресу задають seeds, вміст пише `ExtraAccountMetaList::init` у хендлері.
    // Рядок `CHECK` — однорядковий навмисне: другий рядок Anchor бере вже як
    // документацію і кладе в публічний IDL.
    /// CHECK: акаунт стандарту інтерфейсу хука, не Anchor-тип.
    #[account(
        init,
        payer = admin,
        space = ExtraAccountMetaList::size_of(EXTRA_ACCOUNT_COUNT)?,
        seeds = [EXTRA_ACCOUNT_METAS_SEED, mint.key().as_ref()],
        bump,
    )]
    pub extra_account_meta_list: UncheckedAccount<'info>,
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn create_token_handler(ctx: Context<CreateToken>, args: CreateTokenArgs) -> Result<()> {
    args.validate()?;

    let company_key = ctx.accounts.company.key();
    let company_id = ctx.accounts.company.company_id.to_le_bytes();
    let company_seeds: &[&[u8]] = &[Company::SEED, &company_id, &[ctx.accounts.company.bump]];
    let signer = &[company_seeds];

    let company = ctx.accounts.company.to_account_info();
    let mint = ctx.accounts.mint.to_account_info();
    let token_program = ctx.accounts.token_program.key();

    // Метадані змінної довжини лежать у самому мінті, а `init` рахував місце
    // лише під розширення фіксованого розміру. Реалокацію робить сама
    // токен-програма, але ренту за приріст вона не доплачує — це наша справа,
    // інакше мінт лишився б не звільненим від ренти.
    let metadata = TokenMetadata {
        update_authority: OptionalNonZeroPubkey::try_from(Some(company_key))?,
        mint: ctx.accounts.mint.key(),
        name: args.name.clone(),
        symbol: args.symbol.clone(),
        uri: args.uri.clone(),
        additional_metadata: Vec::new(),
    };
    let grown = mint.data_len().saturating_add(metadata.tlv_size_of()?);
    let top_up = Rent::get()?
        .minimum_balance(grown)
        .saturating_sub(mint.lamports());
    if top_up > 0 {
        transfer(
            CpiContext::new(
                ctx.accounts.system_program.key(),
                Transfer {
                    from: ctx.accounts.admin.to_account_info(),
                    to: mint.clone(),
                },
            ),
            top_up,
        )?;
    }
    token_metadata_initialize(
        CpiContext::new_with_signer(
            token_program,
            TokenMetadataInitialize {
                program_id: ctx.accounts.token_program.to_account_info(),
                metadata: mint.clone(),
                update_authority: company.clone(),
                mint_authority: company.clone(),
                mint: mint.clone(),
            },
            signer,
        ),
        args.name.clone(),
        args.symbol.clone(),
        args.uri,
    )?;

    // Уся емісія — один раз і сюди (FR-019). Хук на `mint_to` не викликається,
    // тож допуск казначейства не перевіряється й перевірятись не має.
    mint_to(
        CpiContext::new_with_signer(
            token_program,
            MintTo {
                mint: mint.clone(),
                to: ctx.accounts.treasury.to_account_info(),
                authority: company.clone(),
            },
            signer,
        ),
        args.total_supply,
    )?;

    // І одразу віддаємо право емісії: «більше не домінтимо» має бути видно з
    // самого мінта (`mintAuthority: null`), а не з нашого коду.
    set_authority(
        CpiContext::new_with_signer(
            token_program,
            SetAuthority {
                current_authority: company,
                account_or_mint: mint,
            },
            signer,
        ),
        AuthorityType::MintTokens,
        None,
    )?;

    // Список додаткових акаунтів пишеться один раз і на весь час життя токена
    // (див. `hook::extra_account_metas`).
    ExtraAccountMetaList::init::<ExecuteInstruction>(
        &mut ctx.accounts.extra_account_meta_list.try_borrow_mut_data()?,
        &extra_account_metas()?,
    )?;

    let config = &mut ctx.accounts.token_config;
    config.company = company_key;
    config.mint = ctx.accounts.mint.key();
    config.treasury_owner = company_key;
    config.policy = args.policy;
    config.policy_version = 1;
    config.decimals = args.decimals;
    config.total_supply = args.total_supply;
    config.bump = ctx.bumps.token_config;

    ctx.accounts.company.token_count = ctx
        .accounts
        .company
        .token_count
        .checked_add(1)
        .ok_or(CaprailError::InvalidSupply)?;

    emit!(TokenCreated {
        company: company_key,
        mint: ctx.accounts.mint.key(),
        treasury: ctx.accounts.treasury.key(),
        name: args.name,
        symbol: args.symbol,
        decimals: args.decimals,
        total_supply: args.total_supply,
        policy: args.policy,
        policy_version: 1,
    });
    Ok(())
}
