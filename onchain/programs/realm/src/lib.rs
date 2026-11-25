//! The Casino & The Church. SOL stays on L1 (Bank, Purse); play happens on a MagicBlock Ephemeral Rollup (House, Player).

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke_signed;
use anchor_lang::Discriminator;
use ephemeral_rollups_sdk::anchor::{commit, delegate, ephemeral, vrf};
use ephemeral_rollups_sdk::cpi::DelegateConfig;
use ephemeral_rollups_sdk::ephem::{CallHandler, MagicIntentBundleBuilder};
use ephemeral_rollups_sdk::vrf::consts::{program_identity_pubkey, scoped_vrf_identity_const, DEFAULT_EPHEMERAL_QUEUE};
use ephemeral_rollups_sdk::vrf::instructions::{create_request_randomness_ix_const, RequestRandomnessParams};
use ephemeral_rollups_sdk::vrf::types::SerializableAccountMeta;
use ephemeral_rollups_sdk::{ActionArgs, ShortAccountMeta};
use session_keys::SessionTokenV2;
use solana_instructions_sysvar::{load_current_index_checked, load_instruction_at_checked};

pub mod bets;
pub mod blackjack;
pub mod constants;
pub mod error;
pub mod games;
pub mod market;
pub mod money;
pub mod state;

use bets::BetError;
use constants::*;
use error::RealmError;
use market::{MarketError, Tick};
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
            BetError::NoHand => RealmError::NoHand,
            BetError::CannotDouble => RealmError::CannotDouble,
            BetError::Overflow => RealmError::Overflow,
        }
    }
}
fn bet_ok<T>(r: core::result::Result<T, BetError>) -> Result<T> {
    r.map_err(|e| error!(RealmError::from(e)))
}

impl From<MarketError> for RealmError {
    fn from(e: MarketError) -> Self {
        match e {
            MarketError::Closed => RealmError::MarketClosed,
            MarketError::RoundMoved => RealmError::RoundMoved,
            MarketError::RoundLocked => RealmError::RoundLocked,
            MarketError::BadPick => RealmError::BadPick,
            MarketError::BadWager => RealmError::BadWager,
            MarketError::MaxBet => RealmError::MaxBet,
            MarketError::AlreadyBet => RealmError::AlreadyBet,
            MarketError::SlotsFull => RealmError::SlotsFull,
            MarketError::NoChips => RealmError::NoChips,
            MarketError::VaultLow => RealmError::VaultLow,
            MarketError::BadArgs => RealmError::BadArgs,
            MarketError::Overflow => RealmError::Overflow,
        }
    }
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

    // ================================================================ L1: the BTC market

    pub fn init_market(ctx: Context<InitMarket>) -> Result<()> {
        {
            let mut m = ctx.accounts.market.load_init()?;
            m.round_s = 60;
            m.grace_s = 20;
            m.payout_bps = 19_000;
            m.wagers = [1, 2, 5, 10, 0, 0, 0, 0];
            m.bump = ctx.bumps.market;
            m.version = 1;
        }
        // the market pays for its own crank on the rollup (an ephemeral account costs 32 lamports a byte)
        anchor_lang::system_program::transfer(
            CpiContext::new(ctx.accounts.system_program.key(), anchor_lang::system_program::Transfer { from: ctx.accounts.admin.to_account_info(), to: ctx.accounts.market.to_account_info() }),
            5_000_000,
        )
    }

    /// First time, or after a rotation. Anyone may pay for it: it can only go to our rollup.
    pub fn delegate_market(ctx: Context<DelegateMarket>) -> Result<()> {
        {
            let info = ctx.accounts.market.to_account_info();
            require_keys_eq!(*info.owner, crate::ID, RealmError::BadArgs);
            let mut data = info.try_borrow_mut_data()?;
            market_check(&data)?;
            let m: &mut Market = bytemuck::try_from_bytes_mut(&mut data[8..Market::SPACE]).map_err(|_| error!(RealmError::BadArgs))?;
            m.commits = 0;
        }
        ctx.accounts.delegate_market(&ctx.accounts.payer, &[SEED_MARKET], DelegateConfig { validator: Some(ctx.accounts.config.er_validator), ..Default::default() })?;
        Ok(())
    }

    /// Writes 60 finished rounds into Solana's own history, from the market as it was last saved. Anyone may call it; it
    /// reads the saved account, so nobody can make a number up. `page` is epoch / 60, and the `rounds` address only makes
    /// the record easy to find. Afterwards these lines outlive the rollup's history and our server.
    pub fn log_rounds(ctx: Context<LogRounds>, page: u32) -> Result<()> {
        let info = ctx.accounts.market.to_account_info();
        require!(*info.owner == crate::ID || *info.owner == DELEGATION_PROGRAM, RealmError::BadArgs);
        let data = info.try_borrow_data()?;
        market_check(&data)?;
        let m: &Market = bytemuck::try_from_bytes(&data[8..Market::SPACE]).map_err(|_| error!(RealmError::BadArgs))?;
        let from = u64::from(page) * 60;
        // a page is written once it is whole, so an early call cannot pass off a part of it as the record
        require!(market::outcome_at(m, from + 59).is_some(), RealmError::TooEarly);
        let mut n = 0;
        for e in from..from + 60 {
            let r = &m.rounds[(e % RING) as usize];
            if e != 0 && u64::from(r.epoch) == e {
                anchor_lang::solana_program::log::sol_log(&market::line(r));
                n += 1;
            }
        }
        require!(n > 0, RealmError::NothingPending);
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
        let a = &ctx.accounts;
        let ix = ask_oracle(a.signer.key(), a.oracle_queue.key(), a.player.key(), a.house.key(), instruction::SettleBet::DISCRIMINATOR, seed, seq.to_le_bytes().to_vec());
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
        let (seq, wager) = bet_ok(if p.hand.awaiting != 0 { blackjack::refund(&mut p, &mut h, now) } else { bets::refund(&mut p, &mut h, now) })?;
        emit!(BetRefunded { wallet: p.authority, seq, wager });
        Ok(())
    }

    // ================================================================ rollup: blackjack

    /// Takes the bet, holds 4x, and asks for the first three cards. `bj_settle` answers.
    pub fn bj_deal(ctx: Context<PlaceBet>, chips: u64, client_seed: [u8; 32]) -> Result<()> {
        authorize(&ctx.accounts.signer.key(), &ctx.accounts.authority.key(), ctx.accounts.session_token.as_ref())?;
        let now = Clock::get()?.unix_timestamp;
        let seq = {
            let mut p = ctx.accounts.player.load_mut()?;
            let mut h = ctx.accounts.house.load_mut()?;
            touch(&mut p, &mut h, &ctx.accounts.purse)?;
            let seq = bet_ok(blackjack::deal(&mut p, &mut h, chips, now))?;
            emit!(BetPlaced { wallet: p.authority, seq, game: games::BLACKJACK, pick: 0, wager: chips * CHIP });
            seq
        };
        let a = &ctx.accounts;
        let ix = ask_for_cards(a.signer.key(), a.oracle_queue.key(), a.player.key(), a.house.key(), &client_seed, seq, 0);
        ctx.accounts.invoke_signed_vrf(&ctx.accounts.signer.to_account_info(), &ix)?;
        Ok(())
    }

    /// 2 hit, 3 stand, 4 double. Each asks for its own randomness.
    pub fn bj_act(ctx: Context<PlaceBet>, action: u8, client_seed: [u8; 32]) -> Result<()> {
        authorize(&ctx.accounts.signer.key(), &ctx.accounts.authority.key(), ctx.accounts.session_token.as_ref())?;
        let now = Clock::get()?.unix_timestamp;
        let (seq, step) = {
            let mut p = ctx.accounts.player.load_mut()?;
            let mut h = ctx.accounts.house.load_mut()?;
            touch(&mut p, &mut h, &ctx.accounts.purse)?;
            bet_ok(blackjack::act(&mut p, &mut h, action, now))?
        };
        let a = &ctx.accounts;
        let ix = ask_for_cards(a.signer.key(), a.oracle_queue.key(), a.player.key(), a.house.key(), &client_seed, seq, step);
        ctx.accounts.invoke_signed_vrf(&ctx.accounts.signer.to_account_info(), &ix)?;
        Ok(())
    }

    /// A hand nobody has touched for `bj_idle_s`: anyone may stand for the player, so no hand stays open for ever.
    pub fn bj_stand_idle(ctx: Context<StandIdle>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let (seq, step) = {
            let mut p = ctx.accounts.player.load_mut()?;
            let mut h = ctx.accounts.house.load_mut()?;
            bet_ok(blackjack::stand_idle(&mut p, &mut h, now))?
        };
        let a = &ctx.accounts;
        let ix = ask_for_cards(a.signer.key(), a.oracle_queue.key(), a.player.key(), a.house.key(), &[0; 32], seq, step);
        ctx.accounts.invoke_signed_vrf(&ctx.accounts.signer.to_account_info(), &ix)?;
        Ok(())
    }

    /// Only the VRF program can call this, and like `settle_bet` it never fails on an answer nobody is waiting for.
    pub fn bj_settle(ctx: Context<SettleBet>, randomness: [u8; 32], seq: u64, step: u8) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let mut p = ctx.accounts.player.load_mut()?;
        let mut h = ctx.accounts.house.load_mut()?;
        let (per_min, window) = (h.params.decay_per_min_milli, h.params.max_decay_window_s);
        money::decay(&mut p, now, per_min, window);
        if let Some(s) = blackjack::answer(&mut p, &mut h, &randomness, seq, step, now) {
            let x = p.hand;
            emit!(HandStep { wallet: p.authority, seq, step, action: s.action, player: x.player, n_player: x.n_player, dealer: x.dealer, n_dealer: x.n_dealer, randomness });
            if let Some(d) = s.done {
                emit!(BetSettled { wallet: p.authority, seq, game: games::BLACKJACK, pick: 0, wager: d.wager, payout: d.payout, blessing: d.blessing, luck_gain_milli: d.luck_gain_milli, outcome: d.outcome, jackpot: false, randomness });
            }
        }
        Ok(())
    }

    // ================================================================ rollup: the BTC market

    pub fn market_start(ctx: Context<AdminMarket>) -> Result<()> {
        let mut m = ctx.accounts.market.load_mut()?;
        market::start(&mut m, Clock::get()?.unix_timestamp);
        Ok(())
    }
    /// Voids whatever is running, so every bet comes back.
    pub fn market_stop(ctx: Context<AdminMarket>) -> Result<()> {
        let mut m = ctx.accounts.market.load_mut()?;
        if let Some(t) = market::stop(&mut m, Clock::get()?.unix_timestamp) { tell(&t, &m); }
        Ok(())
    }
    /// Only while stopped, so no bet is ever placed under one set of rules and decided under another.
    pub fn market_config(ctx: Context<AdminMarket>, round_s: u32, grace_s: u32, payout_bps: u32, wagers: [u32; 8]) -> Result<()> {
        let mut m = ctx.accounts.market.load_mut()?;
        require!(m.enabled == 0, RealmError::BadArgs);
        require!((30..=900).contains(&round_s) && (10..=120).contains(&grace_s) && (10_000..=19_800).contains(&payout_bps) && wagers.iter().any(|w| *w > 0), RealmError::BadArgs);
        m.round_s = round_s;
        m.grace_s = grace_s;
        m.payout_bps = payout_bps;
        m.wagers = wagers;
        Ok(())
    }

    /// A Hydra crank that calls `market_tick` for ever. It is made by the market's own address, which proves whose it is.
    /// It only counts once its address is in Config.
    pub fn market_crank_create(ctx: Context<MarketCrank>, seed: [u8; 32], interval_slots: u64) -> Result<()> {
        let a = &ctx.accounts;
        let tick = Instruction {
            program_id: crate::ID,
            accounts: vec![
                AccountMeta::new(a.market.key(), false),
                AccountMeta::new_readonly(a.house.key(), false),
                AccountMeta::new_readonly(a.config.key(), false),
                AccountMeta::new_readonly(a.config.btc_feed, false),
                AccountMeta::new_readonly(INSTRUCTIONS_SYSVAR, false),
                AccountMeta::new_readonly(crate::ID, false), // no keeper
            ],
            data: anchor_lang::InstructionData::data(&crate::instruction::MarketTick {}),
        };
        let mut d = vec![0u8];
        d.extend_from_slice(&seed);
        d.extend_from_slice(a.market.key().as_ref());
        d.extend_from_slice(&Clock::get()?.slot.to_le_bytes()); // from now: 0 would make Hydra catch up from slot 0
        d.extend_from_slice(&interval_slots.to_le_bytes());
        d.extend_from_slice(&0u64.to_le_bytes()); // for ever
        d.extend_from_slice(&0u64.to_le_bytes()); // no tip
        d.extend_from_slice(&0u32.to_le_bytes());
        d.push(tick.accounts.len() as u8);
        d.extend_from_slice(&(tick.data.len() as u16).to_le_bytes());
        d.extend_from_slice(tick.program_id.as_ref());
        for m in &tick.accounts {
            d.push(if m.is_writable { 2 } else { 0 });
            d.extend_from_slice(m.pubkey.as_ref());
        }
        d.extend_from_slice(&tick.data);
        let ix = Instruction {
            program_id: HYDRA,
            accounts: vec![AccountMeta::new(a.market.key(), true), AccountMeta::new(a.crank.key(), false), AccountMeta::new(EPHEMERAL_VAULT, false), AccountMeta::new_readonly(MAGIC_PROGRAM, false)],
            data: d,
        };
        invoke_signed(&ix, &[a.market.to_account_info(), a.crank.to_account_info(), a.ephemeral_vault.to_account_info(), a.magic_program.to_account_info(), a.hydra.to_account_info()], &[&[SEED_MARKET, &[ctx.bumps.market]]])?;
        Ok(())
    }
    pub fn market_crank_cancel(ctx: Context<MarketCrank>) -> Result<()> {
        let a = &ctx.accounts;
        let ix = Instruction {
            program_id: HYDRA,
            accounts: vec![AccountMeta::new(a.market.key(), true), AccountMeta::new(a.crank.key(), false), AccountMeta::new(a.market.key(), false), AccountMeta::new(EPHEMERAL_VAULT, false), AccountMeta::new_readonly(MAGIC_PROGRAM, false)],
            data: vec![2],
        };
        invoke_signed(&ix, &[a.market.to_account_info(), a.crank.to_account_info(), a.ephemeral_vault.to_account_info(), a.magic_program.to_account_info(), a.hydra.to_account_info()], &[&[SEED_MARKET, &[ctx.bumps.market]]])?;
        Ok(())
    }

    /// Called about once a second by the crank. Most calls end at once. The first call that is due takes the price, so only
    /// the crank or the keeper may make it; when the grace is over anyone may, and then it can only void.
    pub fn market_tick(ctx: Context<MarketTick>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let a = &ctx.accounts;
        let crank = is_crank(&a.instructions, &a.config.market_crank)?;
        let keeper = a.keeper.as_ref().is_some_and(|k| k.key() == a.config.keeper);
        let mut m = a.market.load_mut()?;
        if crank {
            if m.last_tick_ts > 0 { m.max_gap_s = m.max_gap_s.max((now - m.last_tick_ts).clamp(0, i64::from(u32::MAX)) as u32); }
            m.last_tick_ts = now;
            m.crank_ticks += 1;
        }
        if a.house.load()?.paused != 0 { return Ok(()); }
        let price = {
            require_keys_eq!(*a.feed.owner, PRICE_PROGRAM, RealmError::BadFeed);
            market::read_feed(&a.feed.try_borrow_data()?)
        };
        let t = market::tick(&mut m, price, crank || keeper, now);
        require!(t != Tick::NotAllowed, RealmError::NotAllowed);
        if keeper && !crank && matches!(t, Tick::Priced { .. }) { m.keeper_prices += 1; }
        tell(&t, &m);
        Ok(())
    }

    pub fn market_bet(ctx: Context<MarketBet>, epoch: u64, side: u8, chips: u64) -> Result<()> {
        let a = &ctx.accounts;
        authorize(&a.signer.key(), &a.authority.key(), a.session_token.as_ref())?;
        let now = Clock::get()?.unix_timestamp;
        let mut p = a.player.load_mut()?;
        let mut h = a.house.load_mut()?;
        let mut m = a.market.load_mut()?;
        touch(&mut p, &mut h, &a.purse)?;
        pay_claims(&mut p, &mut h, &m, now);
        let seq = market::bet(&mut p, &mut h, &mut m, epoch, side, chips, now).map_err(|e| error!(RealmError::from(e)))?;
        emit!(MarketBetPlaced { wallet: p.authority, seq, epoch, side, wager: chips * CHIP });
        Ok(())
    }

    /// Settles every bet of this player whose round is over. Anyone may call it; it only ever pays the bettor.
    pub fn market_claim(ctx: Context<MarketClaim>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let mut p = ctx.accounts.player.load_mut()?;
        let mut h = ctx.accounts.house.load_mut()?;
        let m = ctx.accounts.market.load()?;
        let (per_min, window) = (h.params.decay_per_min_milli, h.params.max_decay_window_s);
        money::decay(&mut p, now, per_min, window);
        pay_claims(&mut p, &mut h, &m, now);
        Ok(())
    }

    /// Saves the market to L1 (the keeper, hourly). An account has 10 saves per delegation, so the ninth also takes it off
    /// the rollup, to be put straight back: that is only allowed early in a round, when nothing is due for a while.
    pub fn market_checkpoint(ctx: Context<MarketCheckpoint>) -> Result<()> {
        let a = &ctx.accounts;
        require!(a.signer.key() == a.config.keeper || a.signer.key() == a.config.admin, RealmError::NotAllowed);
        let leave = {
            let mut m = a.market.load_mut()?;
            m.commits += 1;
            let leave = m.commits >= MARKET_ROTATE_AT;
            require!(!leave || m.enabled == 0 || Clock::get()?.unix_timestamp <= m.open.open_ts + 12, RealmError::TooEarly);
            leave
        };
        let market = [a.market.to_account_info()];
        let intent = MagicIntentBundleBuilder::new(a.signer.to_account_info(), a.magic_context.to_account_info(), a.magic_program.to_account_info());
        if leave { intent.commit_and_undelegate(&market).build_and_invoke()?; } else { intent.commit(&market).build_and_invoke()?; }
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

/// The request every bet makes. The answer can only come back to `callback`, with this player and the house.
fn ask_oracle(payer: Pubkey, oracle_queue: Pubkey, player: Pubkey, house: Pubkey, callback: &[u8], caller_seed: [u8; 32], args: Vec<u8>) -> Instruction {
    let meta = |k: Pubkey| SerializableAccountMeta { pubkey: k, is_signer: false, is_writable: true };
    create_request_randomness_ix_const(
        RequestRandomnessParams {
            payer,
            oracle_queue,
            callback_program_id: crate::ID,
            callback_discriminator: callback.to_vec(),
            caller_seed,
            accounts_metas: Some(vec![meta(player), meta(house)]),
            callback_args: Some(args),
            ..Default::default()
        },
        PROGRAM_IDENTITY,
    )
}
fn ask_for_cards(payer: Pubkey, oracle_queue: Pubkey, player: Pubkey, house: Pubkey, client_seed: &[u8; 32], seq: u64, step: u8) -> Instruction {
    let mut seed = bets::caller_seed(client_seed, &player.to_bytes(), seq);
    seed[8] ^= step; // every step of a hand asks with a different seed
    let mut args = seq.to_le_bytes().to_vec();
    args.push(step);
    ask_oracle(payer, oracle_queue, player, house, instruction::BjSettle::DISCRIMINATOR, seed, args)
}

/// what a tick did, as events and as plain text for explorers
fn tell(t: &Tick, m: &Market) {
    let mut say = |r: &RoundRec| {
        anchor_lang::solana_program::log::sol_log(&market::line(r));
        emit!(RoundClosed { epoch: u64::from(r.epoch), outcome: r.outcome, lock_c: r.lock_c, close_c: r.close_c, closed_ts: r.closed_ts, up_chips: r.up_chips, down_chips: r.down_chips, bets: r.bets });
    };
    match t {
        Tick::Voided { live, open } => {
            if let Some(r) = live { say(r); }
            say(open);
        }
        Tick::Priced { closed, locked, price_c } => {
            if let Some(r) = closed { say(r); }
            msg!("round {} locked at {}.{:02}, round {} open", locked, price_c / 100, price_c % 100, m.open.epoch);
            emit!(RoundLocked { epoch: *locked, lock_c: *price_c, locked_ts: m.live.locked_at, next_lock_ts: m.open.lock_ts });
        }
        _ => {}
    }
}
fn pay_claims(p: &mut Player, h: &mut House, m: &Market, now: i64) {
    for c in market::claim(p, h, m, now) {
        emit!(MarketSettled { wallet: p.authority, seq: c.seq, epoch: c.epoch, side: c.side, outcome: c.outcome, wager: c.wager, payout: c.payout, blessing: c.blessing, luck_gain_milli: c.luck_gain_milli, lock_c: c.lock_c, close_c: c.close_c });
    }
}
fn market_check(data: &[u8]) -> Result<()> {
    require!(data.len() >= Market::SPACE && data[..8] == *<Market as anchor_lang::Discriminator>::DISCRIMINATOR, RealmError::BadArgs);
    Ok(())
}
/// the instruction before ours must be Hydra's Trigger, for exactly this crank
fn is_crank(instructions: &AccountInfo, expected: &Pubkey) -> Result<bool> {
    let k = load_current_index_checked(instructions)? as usize;
    if k == 0 { return Ok(false); }
    let prev = load_instruction_at_checked(k - 1, instructions)?;
    Ok(*expected != Pubkey::default() && prev.program_id == HYDRA && prev.data.first() == Some(&1) && prev.accounts.first().is_some_and(|a| a.pubkey == *expected))
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
pub struct HandStep { pub wallet: Pubkey, pub seq: u64, pub step: u8, pub action: u8, pub player: [u8; 12], pub n_player: u8, pub dealer: [u8; 12], pub n_dealer: u8, pub randomness: [u8; 32] }
#[event]
pub struct MarketBetPlaced { pub wallet: Pubkey, pub seq: u64, pub epoch: u64, pub side: u8, pub wager: u64 }
#[event]
pub struct MarketSettled { pub wallet: Pubkey, pub seq: u64, pub epoch: u64, pub side: u8, pub outcome: u8, pub wager: u64, pub payout: u64, pub blessing: u64, pub luck_gain_milli: u32, pub lock_c: u32, pub close_c: u32 }
#[event]
pub struct RoundLocked { pub epoch: u64, pub lock_c: u32, pub locked_ts: i64, pub next_lock_ts: i64 }
#[event]
pub struct RoundClosed { pub epoch: u64, pub outcome: u8, pub lock_c: u32, pub close_c: u32, pub closed_ts: u32, pub up_chips: u32, pub down_chips: u32, pub bets: u16 }
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

/// No session and no player signature: it only does what `bj_idle_s` already allows.
#[vrf]
#[derive(Accounts)]
pub struct StandIdle<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,
    /// CHECK: only seeds the PDA
    pub authority: UncheckedAccount<'info>,
    #[account(mut, seeds = [SEED_PLAYER, authority.key().as_ref()], bump)]
    pub player: AccountLoader<'info, Player>,
    #[account(mut, seeds = [SEED_HOUSE], bump)]
    pub house: AccountLoader<'info, House>,
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

#[derive(Accounts)]
pub struct InitMarket<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(seeds = [SEED_CONFIG], bump = config.bump, has_one = admin @ RealmError::NotAllowed)]
    pub config: Box<Account<'info, Config>>,
    #[account(init, payer = admin, space = Market::SPACE, seeds = [SEED_MARKET], bump)]
    pub market: AccountLoader<'info, Market>,
    pub system_program: Program<'info, System>,
}

#[delegate]
#[derive(Accounts)]
pub struct DelegateMarket<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [SEED_CONFIG], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    /// CHECK: our PDA; owner and discriminator are checked in the handler
    #[account(mut, del, seeds = [SEED_MARKET], bump)]
    pub market: UncheckedAccount<'info>,
}

#[derive(Accounts)]
#[instruction(page: u32)]
pub struct LogRounds<'info> {
    /// CHECK: owner and discriminator are checked in the handler
    #[account(seeds = [SEED_MARKET], bump)]
    pub market: UncheckedAccount<'info>,
    /// CHECK: an empty address; it only makes the record easy to find
    #[account(seeds = [SEED_ROUNDS, page.to_le_bytes().as_ref()], bump)]
    pub rounds: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct AdminMarket<'info> {
    pub admin: Signer<'info>,
    #[account(seeds = [SEED_CONFIG], bump = config.bump, has_one = admin @ RealmError::NotAllowed)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [SEED_MARKET], bump)]
    pub market: AccountLoader<'info, Market>,
}

#[derive(Accounts)]
pub struct MarketCrank<'info> {
    pub admin: Signer<'info>,
    #[account(seeds = [SEED_CONFIG], bump = config.bump, has_one = admin @ RealmError::NotAllowed)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [SEED_MARKET], bump)]
    pub market: AccountLoader<'info, Market>,
    /// CHECK: only its key is used
    #[account(seeds = [SEED_HOUSE], bump)]
    pub house: UncheckedAccount<'info>,
    /// CHECK: Hydra derives and checks it
    #[account(mut)]
    pub crank: UncheckedAccount<'info>,
    /// CHECK: fixed address
    #[account(mut, address = EPHEMERAL_VAULT)]
    pub ephemeral_vault: UncheckedAccount<'info>,
    /// CHECK: fixed address
    #[account(address = MAGIC_PROGRAM)]
    pub magic_program: UncheckedAccount<'info>,
    /// CHECK: fixed address
    #[account(address = HYDRA)]
    pub hydra: UncheckedAccount<'info>,
}

/// The order matters: `market_crank_create` lists the same six accounts for the crank.
#[derive(Accounts)]
pub struct MarketTick<'info> {
    #[account(mut, seeds = [SEED_MARKET], bump)]
    pub market: AccountLoader<'info, Market>,
    #[account(seeds = [SEED_HOUSE], bump)]
    pub house: AccountLoader<'info, House>,
    #[account(seeds = [SEED_CONFIG], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    /// CHECK: address pinned here, owner and layout checked in the handler
    #[account(address = config.btc_feed @ RealmError::BadFeed)]
    pub feed: UncheckedAccount<'info>,
    /// CHECK: the instructions sysvar
    #[account(address = INSTRUCTIONS_SYSVAR)]
    pub instructions: UncheckedAccount<'info>,
    pub keeper: Option<Signer<'info>>,
}

#[derive(Accounts)]
pub struct MarketBet<'info> {
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
    #[account(mut, seeds = [SEED_MARKET], bump)]
    pub market: AccountLoader<'info, Market>,
}

#[derive(Accounts)]
pub struct MarketClaim<'info> {
    /// CHECK: only seeds the PDA
    pub authority: UncheckedAccount<'info>,
    #[account(mut, seeds = [SEED_PLAYER, authority.key().as_ref()], bump)]
    pub player: AccountLoader<'info, Player>,
    #[account(mut, seeds = [SEED_HOUSE], bump)]
    pub house: AccountLoader<'info, House>,
    #[account(seeds = [SEED_MARKET], bump)]
    pub market: AccountLoader<'info, Market>,
}

#[commit]
#[derive(Accounts)]
pub struct MarketCheckpoint<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,
    #[account(seeds = [SEED_CONFIG], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [SEED_MARKET], bump)]
    pub market: AccountLoader<'info, Market>,
}
