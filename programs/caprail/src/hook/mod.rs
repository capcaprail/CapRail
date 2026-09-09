//! Зв'язок із програмою-хуком `caprail-hook` — окремою програмою, бо Solana
//! забороняє непряму реентерабельність: `caprail → Token-2022 → caprail`
//! рантайм відкидає (`ReentrancyNotAllowed`), тож програма, яка є хуком мінта,
//! не може сама переказувати цей мінт через CPI — а `distribute`, гранти й
//! пропозиції саме це й роблять. Правило (`execute`) живе в хуку і **читає**
//! стан цієї програми; змінює стан лише ця програма.
//!
//! Залежність іде в один бік: хук залежить від `caprail` (типи акаунтів із
//! правильним власником, список акаунтів, seeds), а `caprail` кличе хук
//! ручною інструкцією за константами звідси. Тести хука тримають константи
//! зіставленими з його `declare_id!` і згенерованим дискримінатором.

pub mod extra_account_metas;

pub use extra_account_metas::*;

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::Instruction;

/// Адреса програми-хука; ключ — поза репозиторієм, як і в `caprail`.
pub const HOOK_PROGRAM_ID: Pubkey = pubkey!("6EMZVfUkf2wrtwfnESLghWfdWyzDu71uJTJ7dCKG3YEi");

/// Anchor-дискримінатор `initialize_extra_account_meta_list` у хуку
/// (`sha256("global:initialize_extra_account_meta_list")[..8]`). Тест хука
/// звіряє його з `DISCRIMINATOR` згенерованої інструкції.
pub const INITIALIZE_LIST_DISCRIMINATOR: [u8; 8] = [92, 197, 174, 197, 41, 124, 19, 3];

/// Інструкція хука, що створює `ExtraAccountMetaList` мінта. Порядок акаунтів
/// — розкладка `InitializeExtraAccountMetaList` у хуку; тест там звіряє метадані
/// цього білдера з `to_account_metas` згенерованої структури.
pub fn initialize_list_instruction(
    payer: &Pubkey,
    mint: &Pubkey,
    authority: &Pubkey,
    extra_account_meta_list: &Pubkey,
) -> Instruction {
    Instruction {
        program_id: HOOK_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(*payer, true),
            AccountMeta::new_readonly(*mint, false),
            AccountMeta::new_readonly(*authority, true),
            AccountMeta::new(*extra_account_meta_list, false),
            AccountMeta::new_readonly(anchor_lang::system_program::ID, false),
        ],
        data: INITIALIZE_LIST_DISCRIMINATOR.to_vec(),
    }
}

/// PDA списку під програмою-хуком — саме там його шукає Token-2022.
pub fn find_extra_account_meta_list(mint: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[EXTRA_ACCOUNT_METAS_SEED, mint.as_ref()], &HOOK_PROGRAM_ID)
}
