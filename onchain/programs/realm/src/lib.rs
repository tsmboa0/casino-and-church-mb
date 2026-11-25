//! The Casino & The Church. SOL stays on L1 (Bank, Purse); play happens on a MagicBlock Ephemeral Rollup (House, Player).

use anchor_lang::prelude::*;
use anchor_lang::Discriminator;
use ephemeral_rollups_sdk::anchor::{commit, delegate, ephemeral, vrf};
use ephemeral_rollups_sdk::cpi::DelegateConfig;
use ephemeral_rollups_sdk::ephem::{CallHandler, MagicIntentBundleBuilder};
use ephemeral_rollups_sdk::vrf::consts::{program_identity_pubkey, scoped_vrf_identity_const, DEFAULT_EPHEMERAL_QUEUE};
use ephemeral_rollups_sdk::vrf::instructions::{create_request_randomness_ix_const, RequestRandomnessParams};
use ephemeral_rollups_sdk::vrf::types::SerializableAccountMeta;
use ephemeral_rollups_sdk::{ActionArgs, ShortAccountMeta};
use session_keys::SessionTokenV2;

pub mod bets;
pub mod constants;
pub mod error;
pub mod games;
pub mod money;
pub mod state;

use bets::BetError;
use constants::*;
use error::RealmError;
use money::MoneyError;
use state::*;

declare_id!("6uoz1h2ZWQMgniDx2vKEvh6bHtgCoFoGegfVtNW1q6cX");

/// who may ask for randomness for us, and who may answer. Both worked out at COMPILE time: SDK 0.18.0's #[vrf_callback]
/// derives the answerer at runtime and uses up the whole compute budget (docs/spike.md), so it must not be used.
const PROGRAM_IDENTITY: Pubkey = program_identity_pubkey(&crate::ID);
const VRF_IDENTITY: Pubkey = Pubkey::new_from_array(scoped_vrf_identity_const(&crate::ID).0);

impl From<BetError> for RealmError {
    fn from(e: BetError) -> Self {
        match e {
            BetError::Busy => RealmError::BetPending,
            BetError::BadPick => RealmError::BadPick,
            BetError::BadWager => RealmError::BadWager,
            BetError::MaxBet => RealmError::MaxBet,
            BetError::NoChips => RealmError::NoChips,
            BetError::LuckLow => RealmError::LuckLow,
            BetError::FaithLow => RealmError::FaithLow,
            BetError::Cooldown => RealmError::Cooldown,
            BetError::VaultLow => RealmError::VaultLow,
            BetError::NothingPending => RealmError::NothingPending,
            BetError::TooEarly => RealmError::TooEarly,
            BetError::Overflow => RealmError::Overflow,
        }
    }
}
fn bet_ok<T>(r: core::result::Result<T, BetError>) -> Result<T> {
    r.map_err(|e| error!(RealmError::from(e)))
}

impl From<MoneyError> for RealmError {
    fn from(e: MoneyError) -> Self {
        match e {
            MoneyError::Overflow => RealmError::Overflow,
            MoneyError::NoChips => RealmError::NoChips,
            MoneyError::BadAmount => RealmError::BadAmount,
            MoneyError::Busy => RealmError::BetPending,
            MoneyError::VaultLow => RealmError::VaultLow,
            MoneyError::AlreadyClaimed => RealmError::AlreadyClaimed,
        }
    }
}
fn ok<T>(r: core::result::Result<T, MoneyError>) -> Result<T> {
    r.map_err(|e| error!(RealmError::from(e)))
}

#[ephemeral]
#[program]
pub mod realm {
    use super::*;

    // ================================================================ L1: setup and roles

    pub fn init(ctx: Context<Init>, args: InitArgs) -> Result<()> {
        let c = &mut ctx.accounts.config;
        c.version = 1;
        c.admin = ctx.accounts.admin.key();
        c.fortuna = args.fortuna;
        c.nakamoto = args.nakamoto;
        c.church_oracle = args.church_oracle;
        c.keeper = args.keeper;
        c.er_validator = args.er_validator;
        c.btc_feed = args.btc_feed;
        c.min_deposit = args.min_deposit;
        c.max_deposit = args.max_deposit;
        c.payout_cap_player_day = args.payout_cap_player_day;
        c.payout_cap_global_hour = args.payout_cap_global_hour;
        c.bump = ctx.bumps.config;
        ctx.accounts.bank.bump = ctx.bumps.bank;
        ctx.accounts.house_purse.bump = ctx.bumps.house_purse;
        let mut h = ctx.accounts.house.load_init()?;
        h.params = Params::launch();
        h.bump = ctx.bumps.house;
        h.version = 1;
        Ok(())
    }

    pub fn set_config(ctx: Context<AdminConfig>, patch: ConfigPatch) -> Result<()> {
        let c = &mut ctx.accounts.config;
        if let Some(v) = patch.fortuna { c.fortuna = v; }
        if let Some(v) = patch.nakamoto { c.nakamoto = v; }
        if let Some(v) = patch.church_oracle { c.church_oracle = v; }
        if let Some(v) = patch.keeper { c.keeper = v; }
        if let Some(v) = patch.er_validator { c.er_validator = v; }
        if let Some(v) = patch.btc_feed { c.btc_feed = v; }
        if let Some(v) = patch.market_crank { c.market_crank = v; }
        if let Some(v) = patch.deposits_paused { c.deposits_paused = v; }
        if let Some(v) = patch.payouts_paused { c.payouts_paused = v; }
        if let Some(v) = patch.min_deposit { c.min_deposit = v; }
        if let Some(v) = patch.max_deposit { c.max_deposit = v; }
        if let Some(v) = patch.payout_cap_player_day { c.payout_cap_player_day = v; }
        if let Some(v) = patch.payout_cap_global_hour { c.payout_cap_global_hour = v; }
        if let Some(v) = patch.pending_admin { c.pending_admin = v; }
        require!(c.min_deposit >= CHIP && c.max_deposit >= c.min_deposit, RealmError::BadArgs);
        Ok(())
    }

    pub fn accept_admin(ctx: Context<AcceptAdmin>) -> Result<()> {
        let c = &mut ctx.accounts.config;
        c.admin = ctx.accounts.new_admin.key();
        c.pending_admin = Pubkey::default();
        Ok(())
    }

    pub fn delegate_house(ctx: Context<DelegateHouse>) -> Result<()> {
        ctx.accounts.delegate_house(
            &ctx.accounts.admin,
            &[SEED_HOUSE],
            DelegateConfig { validator: Some(ctx.accounts.config.er_validator), ..Default::default() },
        )?;
        Ok(())
    }

    // ================================================================ L1: money

    /// The house's own money. `pool`: 0 vault, 1 treasury, 2 jackpot.
    pub fn fund_house(ctx: Context<FundHouse>, pool: u8, lamports: u64) -> Result<()> {
        require!(lamports > 0 && lamports % CHIP == 0, RealmError::BadAmount);
        pay_into_bank(&ctx.accounts.admin, &ctx.accounts.bank, &ctx.accounts.system_program, lamports)?;
        let b = &mut ctx.accounts.bank;
        b.total_deposited = b.total_deposited.checked_add(lamports).ok_or(RealmError::Overflow)?;
        let hp = &mut ctx.accounts.house_purse;
        let slot = match pool {
            0 => &mut hp.vault,
            1 => &mut hp.treasury,
            2 => &mut hp.jackpot,
            _ => return err!(RealmError::BadArgs),
        };
        *slot = slot.checked_add(lamports).ok_or(RealmError::Overflow)?;
        Ok(())
    }

    /// Purse (L1 forever) and Player (about to be delegated). Both must be new: recreating either would credit old
    /// deposits again, so `init` is the whole point here.
    pub fn open_account(ctx: Context<OpenAccount>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let pu = &mut ctx.accounts.purse;
        pu.owner = ctx.accounts.owner.key();
        pu.bump = ctx.bumps.purse;
        let mut p = ctx.accounts.player.load_init()?;
        p.authority = ctx.accounts.owner.key();
        p.bump = ctx.bumps.player;
        p.version = 1;
        p.last_update = now;
        emit!(Opened { wallet: p.authority });
        Ok(())
    }

    /// Puts a Player that is on L1 onto the rollup (first time, or after a rotation). Anyone may pay for it.
    pub fn delegate_player(ctx: Context<DelegatePlayer>) -> Result<()> {
        {
            let info = ctx.accounts.player.to_account_info();
            require_keys_eq!(*info.owner, crate::ID, RealmError::BadPlayer);
            let mut data = info.try_borrow_mut_data()?;
            let p = player_mut(&mut data)?;
            require_keys_eq!(p.authority, ctx.accounts.owner.key(), RealmError::BadPlayer);
            p.commits = 0;
        }
        let owner = ctx.accounts.owner.key();
        ctx.accounts.delegate_player(
            &ctx.accounts.payer,
            &[SEED_PLAYER, owner.as_ref()],
            DelegateConfig { validator: Some(ctx.accounts.config.er_validator), ..Default::default() },
        )?;
        Ok(())
    }

    pub fn buy_chips(ctx: Context<BuyChips>, lamports: u64) -> Result<()> {
        let c = &ctx.accounts.config;
        require!(!c.deposits_paused, RealmError::DepositsPaused);
        require!(lamports >= c.min_deposit && lamports <= c.max_deposit && lamports % CHIP == 0, RealmError::BadAmount);
        pay_into_bank(&ctx.accounts.owner, &ctx.accounts.bank, &ctx.accounts.system_program, lamports)?;
        let b = &mut ctx.accounts.bank;
        b.total_deposited = b.total_deposited.checked_add(lamports).ok_or(RealmError::Overflow)?;
        let pu = &mut ctx.accounts.purse;
        pu.deposited = pu.deposited.checked_add(lamports).ok_or(RealmError::Overflow)?;
        pu.last_deposit_ts = Clock::get()?.unix_timestamp;
        emit!(Bought { wallet: pu.owner, lamports, total: pu.deposited });
        Ok(())
    }

    /// Pays what the COMMITTED Player says is owed. Anyone may call it, and the Magic Action after a cash-out does:
    /// the amount and the destination come from state, never from the caller.
    pub fn settle_payout(ctx: Context<SettlePayout>) -> Result<()> {
        require!(!ctx.accounts.config.payouts_paused, RealmError::PayoutsPaused);
        let withdrawn = {
            let info = ctx.accounts.player.to_account_info();
            require!(*info.owner == DELEGATION_PROGRAM || *info.owner == crate::ID, RealmError::BadPlayer);
            let data = info.try_borrow_data()?;
            let p = player_copy(&data)?;
            require_keys_eq!(p.authority, ctx.accounts.purse.owner, RealmError::BadPlayer);
            p.withdrawn
        };
        pay_player(&ctx.accounts.config, &mut ctx.accounts.bank, &mut ctx.accounts.purse, &ctx.accounts.wallet, withdrawn)
    }

    /// Cash-out for a Player that is not on the rollup (between a rotation and the next delegation).
    pub fn cash_out_l1(ctx: Context<CashOutL1>, chips: u64) -> Result<()> {
        require!(!ctx.accounts.config.payouts_paused, RealmError::PayoutsPaused);
        let withdrawn = {
            let mut p = ctx.accounts.player.load_mut()?;
            ok(money::cash_out_l1(&mut p, chips))?;
            p.withdrawn
        };
        pay_player(&ctx.accounts.config, &mut ctx.accounts.bank, &mut ctx.accounts.purse, &ctx.accounts.owner, withdrawn)
    }

    // ================================================================ rollup: money

    pub fn sync_deposit(ctx: Context<SyncDeposit>) -> Result<()> {
        let mut p = ctx.accounts.player.load_mut()?;
        let mut h = ctx.accounts.house.load_mut()?;
        touch(&mut p, &mut h, &ctx.accounts.purse)?;
        Ok(())
    }

    pub fn sync_house(ctx: Context<SyncHouse>) -> Result<()> {
        let mut h = ctx.accounts.house.load_mut()?;
        ok(money::sync_house(&mut h, &ctx.accounts.house_purse))?;
        Ok(())
    }

    pub fn claim_welcome(ctx: Context<Play>) -> Result<()> {
        ctx.accounts.authorize()?;
        let mut p = ctx.accounts.player.load_mut()?;
        let mut h = ctx.accounts.house.load_mut()?;
        touch(&mut p, &mut h, &ctx.accounts.purse)?;
        let amount = ok(money::welcome(&mut p, &mut h, FLAG_WELCOME))?;
        h.total_players += 1;
        emit!(Welcomed { wallet: p.authority, lamports: amount });
        Ok(())
    }

    /// The main wallet only. A session key can never reach this.
    pub fn cash_out(ctx: Context<CashOut>, chips: u64) -> Result<()> {
        let leave = {
            let mut p = ctx.accounts.player.load_mut()?;
            let mut h = ctx.accounts.house.load_mut()?;
            touch(&mut p, &mut h, &ctx.accounts.purse)?;
            let amount = ok(money::cash_out(&mut p, &mut h, chips))?;
            p.commits += 1;
            emit!(CashedOut { wallet: p.authority, lamports: amount, total: p.withdrawn });
            p.commits >= ROTATE_AT_COMMITS
        };
        let key = |k: Pubkey| k.to_bytes().into();
        let payout = CallHandler {
            destination_program: crate::ID,
            accounts: vec![
                ShortAccountMeta { pubkey: key(ctx.accounts.config.key()), is_writable: false },
                ShortAccountMeta { pubkey: key(ctx.accounts.bank.key()), is_writable: true },
                ShortAccountMeta { pubkey: key(ctx.accounts.purse.key()), is_writable: true },
                ShortAccountMeta { pubkey: key(ctx.accounts.authority.key()), is_writable: true },
                ShortAccountMeta { pubkey: key(ctx.accounts.player.key()), is_writable: false },
            ],
            args: ActionArgs::new(anchor_lang::InstructionData::data(&crate::instruction::SettlePayout {})),
            escrow_authority: ctx.accounts.authority.to_account_info(),
            compute_units: 200_000,
        };
        let player = [ctx.accounts.player.to_account_info()];
        let intent = MagicIntentBundleBuilder::new(
            ctx.accounts.authority.to_account_info(),
            ctx.accounts.magic_context.to_account_info(),
            ctx.accounts.magic_program.to_account_info(),
        );
        if leave {
            intent.commit_and_undelegate(&player).add_post_commit_actions([payout]).build_and_invoke()?;
        } else {
            intent.commit(&player).add_post_commit_actions([payout]).build_and_invoke()?;
        }
        Ok(())
    }

    // ================================================================ rollup: bets

    /// Takes the stake, reserves the most it can pay, and asks the oracle for randomness. `settle_bet` answers.
    pub fn place_bet(ctx: Context<PlaceBet>, game: u8, chips: u64, pick: u8, client_seed: [u8; 32]) -> Result<()> {
        authorize(&ctx.accounts.signer.key(), &ctx.accounts.authority.key(), ctx.accounts.session_token.as_ref())?;
        let now = Clock::get()?.unix_timestamp;
        let (seq, seed) = {
            let mut p = ctx.accounts.player.load_mut()?;
            let mut h = ctx.accounts.house.load_mut()?;
            touch(&mut p, &mut h, &ctx.accounts.purse)?;
            let seq = bet_ok(bets::place(&mut p, &mut h, game, chips, pick, client_seed, now))?;
            emit!(BetPlaced { wallet: p.authority, seq, game, pick, wager: chips * CHIP });
            (seq, bets::caller_seed(&client_seed, &ctx.accounts.player.key().to_bytes(), seq))
        };
        let meta = |k: Pubkey| SerializableAccountMeta { pubkey: k, is_signer: false, is_writable: true };
        let ix = create_request_randomness_ix_const(
            RequestRandomnessParams {
                payer: ctx.accounts.signer.key(),
                oracle_queue: ctx.accounts.oracle_queue.key(),
                callback_program_id: crate::ID,
                callback_discriminator: instruction::SettleBet::DISCRIMINATOR.to_vec(),
                caller_seed: seed,
                accounts_metas: Some(vec![meta(ctx.accounts.player.key()), meta(ctx.accounts.house.key())]),
                callback_args: Some(seq.to_le_bytes().to_vec()),
                ..Default::default()
            },
            PROGRAM_IDENTITY,
        );
        ctx.accounts.invoke_signed_vrf(&ctx.accounts.signer.to_account_info(), &ix)?;
        Ok(())
    }

    /// Only the VRF program can call this. It never fails on an answer nobody is waiting for: a failing callback would
    /// be retried over and over.
    pub fn settle_bet(ctx: Context<SettleBet>, randomness: [u8; 32], seq: u64) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let mut p = ctx.accounts.player.load_mut()?;
        let mut h = ctx.accounts.house.load_mut()?;
        let (per_min, window) = (h.params.decay_per_min_milli, h.params.max_decay_window_s);
        money::decay(&mut p, now, per_min, window);
        if let Some(s) = bets::settle(&mut p, &mut h, &randomness, seq, now) {
            emit!(BetSettled { wallet: p.authority, seq: s.seq, game: s.game, pick: s.pick, wager: s.wager, payout: s.payout, blessing: s.blessing, luck_gain_milli: s.luck_gain_milli, outcome: s.outcome, jackpot: s.jackpot, randomness });
        }
        Ok(())
    }

    /// The oracle did not answer in time. Anyone may call it; everything goes back to the player.
    pub fn refund_stale(ctx: Context<Refund>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let mut p = ctx.accounts.player.load_mut()?;
        let mut h = ctx.accounts.house.load_mut()?;
        let (seq, wager) = bet_ok(bets::refund(&mut p, &mut h, now))?;
        emit!(BetRefunded { wallet: p.authority, seq, wager });
        Ok(())
    }

    // ================================================================ rollup: the player's own things

    pub fn set_profile(ctx: Context<Play>, name: String, avatar: String) -> Result<()> {
        ctx.accounts.authorize()?;
        let name = name.trim();
        require!((3..=16).contains(&name.len()) && name.bytes().all(|c| c.is_ascii_alphanumeric() || b" _'-".contains(&c)), RealmError::BadName);
        require!((1..=24).contains(&avatar.len()) && avatar.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_'), RealmError::BadName);
        let mut p = ctx.accounts.player.load_mut()?;
        let mut h = ctx.accounts.house.load_mut()?;
        touch(&mut p, &mut h, &ctx.accounts.purse)?;
        p.name = [0; 16];
        p.name[..name.len()].copy_from_slice(name.as_bytes());
        p.avatar = [0; 24];
        p.avatar[..avatar.len()].copy_from_slice(avatar.as_bytes());
        Ok(())
    }

    /// 0 plaza, 1 casino, 2 church
    pub fn enter_realm(ctx: Context<Play>, realm: u8) -> Result<()> {
        ctx.accounts.authorize()?;
        require!(realm <= 2, RealmError::BadArgs);
        let mut p = ctx.accounts.player.load_mut()?;
        let mut h = ctx.accounts.house.load_mut()?;
        touch(&mut p, &mut h, &ctx.accounts.purse)?;
        if p.realm != realm {
            let now = Clock::get()?.unix_timestamp;
            require!(now >= p.last_realm_change + REALM_COOLDOWN_S, RealmError::Cooldown);
            p.realm = realm;
            p.last_realm_change = now;
        }
        Ok(())
    }

    pub fn complete_tour(ctx: Context<Play>, realm: u8) -> Result<()> {
        ctx.accounts.authorize()?;
        require!(realm <= 2, RealmError::BadArgs);
        let mut p = ctx.accounts.player.load_mut()?;
        let mut h = ctx.accounts.house.load_mut()?;
        touch(&mut p, &mut h, &ctx.accounts.purse)?;
        p.tour_flags |= 1 << realm;
        Ok(())
    }

    // ================================================================ rollup: admin

    pub fn set_paused(ctx: Context<AdminHouse>, paused: bool) -> Result<()> {
        ctx.accounts.house.load_mut()?.paused = u8::from(paused);
        Ok(())
    }
}

// ------------------------------------------------------------------------------------------------ shared steps

/// Every player instruction starts here: not paused, deposits credited, decay applied.
/// Because this syncs, a deposit can never be missed: the next thing the player does credits it.
fn touch(p: &mut Player, h: &mut House, purse: &Purse) -> Result<()> {
    require!(h.paused == 0, RealmError::Paused);
    require_keys_eq!(p.authority, purse.owner, RealmError::BadPlayer);
    ok(money::book_withdrawals(p, h))?;
    let got = ok(money::sync_deposit(p, h, purse.deposited))?;
    if got > 0 {
        emit!(Credited { wallet: p.authority, lamports: got, total: p.credited });
    }
    money::decay(p, Clock::get()?.unix_timestamp, h.params.decay_per_min_milli, h.params.max_decay_window_s);
    Ok(())
}

fn pay_into_bank<'info>(from: &Signer<'info>, bank: &Account<'info, Bank>, system: &Program<'info, System>, lamports: u64) -> Result<()> {
    anchor_lang::system_program::transfer(
        CpiContext::new(system.key(), anchor_lang::system_program::Transfer { from: from.to_account_info(), to: bank.to_account_info() }),
        lamports,
    )
}

fn pay_player<'info>(config: &Account<'info, Config>, bank: &mut Account<'info, Bank>, purse: &mut Account<'info, Purse>, to: &AccountInfo<'info>, withdrawn: u64) -> Result<()> {
    let info = bank.to_account_info();
    let floor = Rent::get()?.minimum_balance(info.data_len());
    let available = info.lamports().saturating_sub(floor);
    let now = Clock::get()?.unix_timestamp;
    let pay = ok(money::payout(withdrawn, purse, bank, now, config.payout_cap_player_day, config.payout_cap_global_hour, available))?;
    if pay > 0 {
        **info.try_borrow_mut_lamports()? -= pay;
        **to.try_borrow_mut_lamports()? += pay;
        emit!(Paid { wallet: purse.owner, lamports: pay, total: purse.paid_out, owed: withdrawn - purse.paid_out });
    }
    Ok(())
}

fn player_check(data: &[u8]) -> Result<()> {
    require!(data.len() >= Player::SPACE && data[..8] == *<Player as anchor_lang::Discriminator>::DISCRIMINATOR, RealmError::BadPlayer);
    Ok(())
}
fn player_copy(data: &[u8]) -> Result<Player> {
    player_check(data)?;
    Ok(bytemuck::pod_read_unaligned(&data[8..Player::SPACE]))
}
fn player_mut(data: &mut [u8]) -> Result<&mut Player> {
    player_check(data)?;
    bytemuck::try_from_bytes_mut(&mut data[8..Player::SPACE]).map_err(|_| error!(RealmError::BadPlayer))
}

// ------------------------------------------------------------------------------------------------ arguments and events

#[derive(AnchorSerialize, AnchorDeserialize)]
pub struct InitArgs {
    pub fortuna: Pubkey,
    pub nakamoto: Pubkey,
    pub church_oracle: Pubkey,
    pub keeper: Pubkey,
    pub er_validator: Pubkey,
    pub btc_feed: Pubkey,
    pub min_deposit: u64,
    pub max_deposit: u64,
    pub payout_cap_player_day: u64,
    pub payout_cap_global_hour: u64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Default)]
pub struct ConfigPatch {
    pub fortuna: Option<Pubkey>,
    pub nakamoto: Option<Pubkey>,
    pub church_oracle: Option<Pubkey>,
    pub keeper: Option<Pubkey>,
    pub er_validator: Option<Pubkey>,
    pub btc_feed: Option<Pubkey>,
    pub market_crank: Option<Pubkey>,
    pub deposits_paused: Option<bool>,
    pub payouts_paused: Option<bool>,
    pub min_deposit: Option<u64>,
    pub max_deposit: Option<u64>,
    pub payout_cap_player_day: Option<u64>,
    pub payout_cap_global_hour: Option<u64>,
    pub pending_admin: Option<Pubkey>,
}

#[event]
pub struct Opened { pub wallet: Pubkey }
#[event]
pub struct Bought { pub wallet: Pubkey, pub lamports: u64, pub total: u64 }
#[event]
pub struct Credited { pub wallet: Pubkey, pub lamports: u64, pub total: u64 }
#[event]
pub struct Welcomed { pub wallet: Pubkey, pub lamports: u64 }
#[event]
pub struct CashedOut { pub wallet: Pubkey, pub lamports: u64, pub total: u64 }
#[event]
pub struct BetPlaced { pub wallet: Pubkey, pub seq: u64, pub game: u8, pub pick: u8, pub wager: u64 }
#[event]
pub struct BetSettled { pub wallet: Pubkey, pub seq: u64, pub game: u8, pub pick: u8, pub wager: u64, pub payout: u64, pub blessing: u64, pub luck_gain_milli: u32, pub outcome: [u8; 4], pub jackpot: bool, pub randomness: [u8; 32] }
#[event]
pub struct BetRefunded { pub wallet: Pubkey, pub seq: u64, pub wager: u64 }
#[event]
pub struct Paid { pub wallet: Pubkey, pub lamports: u64, pub total: u64, pub owed: u64 }

// ------------------------------------------------------------------------------------------------ accounts

#[derive(Accounts)]
pub struct Init<'info> {
    /// only the program's upgrade authority may initialise, so nobody can front-run the deployment
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(constraint = program.programdata_address()? == Some(program_data.key()) @ RealmError::NotAllowed)]
    pub program: Program<'info, crate::program::Realm>,
    #[account(constraint = program_data.upgrade_authority_address == Some(admin.key()) @ RealmError::NotAllowed)]
    pub program_data: Account<'info, ProgramData>,
    #[account(init, payer = admin, space = 8 + Config::INIT_SPACE, seeds = [SEED_CONFIG], bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(init, payer = admin, space = 8 + Bank::INIT_SPACE, seeds = [SEED_BANK], bump)]
    pub bank: Account<'info, Bank>,
    #[account(init, payer = admin, space = 8 + HousePurse::INIT_SPACE, seeds = [SEED_HOUSE_PURSE], bump)]
    pub house_purse: Account<'info, HousePurse>,
    #[account(init, payer = admin, space = House::SPACE, seeds = [SEED_HOUSE], bump)]
    pub house: AccountLoader<'info, House>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminConfig<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [SEED_CONFIG], bump = config.bump, has_one = admin @ RealmError::NotAllowed)]
    pub config: Box<Account<'info, Config>>,
}

#[derive(Accounts)]
pub struct AcceptAdmin<'info> {
    pub new_admin: Signer<'info>,
    #[account(mut, seeds = [SEED_CONFIG], bump = config.bump, constraint = config.pending_admin == new_admin.key() @ RealmError::NotAllowed)]
    pub config: Box<Account<'info, Config>>,
}

#[delegate]
#[derive(Accounts)]
pub struct DelegateHouse<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(seeds = [SEED_CONFIG], bump = config.bump, has_one = admin @ RealmError::NotAllowed)]
    pub config: Box<Account<'info, Config>>,
    /// CHECK: our PDA; the delegation program takes it over
    #[account(mut, del, seeds = [SEED_HOUSE], bump)]
    pub house: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct FundHouse<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(seeds = [SEED_CONFIG], bump = config.bump, has_one = admin @ RealmError::NotAllowed)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [SEED_BANK], bump = bank.bump)]
    pub bank: Account<'info, Bank>,
    #[account(mut, seeds = [SEED_HOUSE_PURSE], bump = house_purse.bump)]
    pub house_purse: Account<'info, HousePurse>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct OpenAccount<'info> {
    /// pays the rent: our sponsor, or anyone
    #[account(mut)]
    pub payer: Signer<'info>,
    pub owner: Signer<'info>,
    #[account(init, payer = payer, space = 8 + Purse::INIT_SPACE, seeds = [SEED_PURSE, owner.key().as_ref()], bump)]
    pub purse: Account<'info, Purse>,
    #[account(init, payer = payer, space = Player::SPACE, seeds = [SEED_PLAYER, owner.key().as_ref()], bump)]
    pub player: AccountLoader<'info, Player>,
    pub system_program: Program<'info, System>,
}

#[delegate]
#[derive(Accounts)]
pub struct DelegatePlayer<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: only seeds the PDA; checked against Player.authority
    pub owner: UncheckedAccount<'info>,
    #[account(seeds = [SEED_CONFIG], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    /// CHECK: our PDA; owner, discriminator and authority are checked in the handler
    #[account(mut, del, seeds = [SEED_PLAYER, owner.key().as_ref()], bump)]
    pub player: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct BuyChips<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(seeds = [SEED_CONFIG], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [SEED_BANK], bump = bank.bump)]
    pub bank: Account<'info, Bank>,
    #[account(mut, seeds = [SEED_PURSE, owner.key().as_ref()], bump = purse.bump, has_one = owner @ RealmError::NotAllowed)]
    pub purse: Account<'info, Purse>,
    pub system_program: Program<'info, System>,
}

/// The order matters: `cash_out` lists the same five accounts for the Magic Action.
#[derive(Accounts)]
pub struct SettlePayout<'info> {
    #[account(seeds = [SEED_CONFIG], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [SEED_BANK], bump = bank.bump)]
    pub bank: Account<'info, Bank>,
    #[account(mut, seeds = [SEED_PURSE, wallet.key().as_ref()], bump = purse.bump)]
    pub purse: Account<'info, Purse>,
    /// CHECK: the purse's owner, nobody else
    #[account(mut, address = purse.owner @ RealmError::NotAllowed)]
    pub wallet: UncheckedAccount<'info>,
    /// CHECK: our PDA; its owner is us or the delegation program, checked in the handler
    #[account(seeds = [SEED_PLAYER, wallet.key().as_ref()], bump)]
    pub player: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct CashOutL1<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(seeds = [SEED_CONFIG], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [SEED_BANK], bump = bank.bump)]
    pub bank: Account<'info, Bank>,
    #[account(mut, seeds = [SEED_PURSE, owner.key().as_ref()], bump = purse.bump, has_one = owner @ RealmError::NotAllowed)]
    pub purse: Account<'info, Purse>,
    #[account(mut, seeds = [SEED_PLAYER, owner.key().as_ref()], bump, constraint = player.load()?.authority == owner.key() @ RealmError::NotAllowed)]
    pub player: AccountLoader<'info, Player>,
}

#[derive(Accounts)]
pub struct SyncDeposit<'info> {
    /// CHECK: only seeds the PDAs
    pub authority: UncheckedAccount<'info>,
    #[account(mut, seeds = [SEED_PLAYER, authority.key().as_ref()], bump)]
    pub player: AccountLoader<'info, Player>,
    #[account(mut, seeds = [SEED_HOUSE], bump)]
    pub house: AccountLoader<'info, House>,
    #[account(seeds = [SEED_PURSE, authority.key().as_ref()], bump = purse.bump)]
    pub purse: Account<'info, Purse>,
}

#[derive(Accounts)]
pub struct SyncHouse<'info> {
    #[account(mut, seeds = [SEED_HOUSE], bump)]
    pub house: AccountLoader<'info, House>,
    #[account(seeds = [SEED_HOUSE_PURSE], bump = house_purse.bump)]
    pub house_purse: Account<'info, HousePurse>,
}

/// Anything a player does while playing. Signed by the session key, or by the main wallet itself.
#[derive(Accounts)]
pub struct Play<'info> {
    pub signer: Signer<'info>,
    /// CHECK: whose player this is; proven by `authorize`
    pub authority: UncheckedAccount<'info>,
    #[account(mut, seeds = [SEED_PLAYER, authority.key().as_ref()], bump)]
    pub player: AccountLoader<'info, Player>,
    #[account(mut, seeds = [SEED_HOUSE], bump)]
    pub house: AccountLoader<'info, House>,
    #[account(seeds = [SEED_PURSE, authority.key().as_ref()], bump = purse.bump)]
    pub purse: Account<'info, Purse>,
    pub session_token: Option<Account<'info, SessionTokenV2>>,
}

impl<'info> Play<'info> {
    pub fn authorize(&self) -> Result<()> {
        authorize(&self.signer.key(), &self.authority.key(), self.session_token.as_ref())
    }
}

/// The main wallet, or a live V2 session that this wallet made for this program and this signer. The account type
/// already proves the token belongs to the session program, which only creates it with the wallet's signature.
pub fn authorize(signer: &Pubkey, authority: &Pubkey, token: Option<&Account<SessionTokenV2>>) -> Result<()> {
    if signer == authority {
        return Ok(());
    }
    let t = token.ok_or(RealmError::BadSession)?;
    require!(
        t.authority == *authority && t.session_signer == *signer && t.target_program == crate::ID && Clock::get()?.unix_timestamp < t.valid_until,
        RealmError::BadSession
    );
    Ok(())
}

#[vrf]
#[derive(Accounts)]
pub struct PlaceBet<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,
    /// CHECK: whose player this is; proven by `authorize`
    pub authority: UncheckedAccount<'info>,
    #[account(mut, seeds = [SEED_PLAYER, authority.key().as_ref()], bump)]
    pub player: AccountLoader<'info, Player>,
    #[account(mut, seeds = [SEED_HOUSE], bump)]
    pub house: AccountLoader<'info, House>,
    #[account(seeds = [SEED_PURSE, authority.key().as_ref()], bump = purse.bump)]
    pub purse: Account<'info, Purse>,
    pub session_token: Option<Account<'info, SessionTokenV2>>,
    /// CHECK: the rollup's VRF queue, and no other
    #[account(mut, address = DEFAULT_EPHEMERAL_QUEUE)]
    pub oracle_queue: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct SettleBet<'info> {
    /// only the VRF program, answering a request this program made, can sign for this
    #[account(address = VRF_IDENTITY @ RealmError::NotAllowed)]
    pub vrf_program_identity: Signer<'info>,
    #[account(mut)]
    pub player: AccountLoader<'info, Player>,
    #[account(mut)]
    pub house: AccountLoader<'info, House>,
}

#[derive(Accounts)]
pub struct Refund<'info> {
    /// CHECK: only seeds the PDA
    pub authority: UncheckedAccount<'info>,
    #[account(mut, seeds = [SEED_PLAYER, authority.key().as_ref()], bump)]
    pub player: AccountLoader<'info, Player>,
    #[account(mut, seeds = [SEED_HOUSE], bump)]
    pub house: AccountLoader<'info, House>,
}

#[commit]
#[derive(Accounts)]
pub struct CashOut<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(mut, seeds = [SEED_PLAYER, authority.key().as_ref()], bump)]
    pub player: AccountLoader<'info, Player>,
    #[account(mut, seeds = [SEED_HOUSE], bump)]
    pub house: AccountLoader<'info, House>,
    #[account(seeds = [SEED_PURSE, authority.key().as_ref()], bump = purse.bump)]
    pub purse: Account<'info, Purse>,
    /// CHECK: passed to the L1 action
    #[account(seeds = [SEED_CONFIG], bump)]
    pub config: UncheckedAccount<'info>,
    /// CHECK: passed to the L1 action
    #[account(seeds = [SEED_BANK], bump)]
    pub bank: UncheckedAccount<'info>,
    /// CHECK: the action's program
    #[account(address = crate::ID)]
    pub program_id: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct AdminHouse<'info> {
    pub admin: Signer<'info>,
    #[account(seeds = [SEED_CONFIG], bump = config.bump, has_one = admin @ RealmError::NotAllowed)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [SEED_HOUSE], bump)]
    pub house: AccountLoader<'info, House>,
}
