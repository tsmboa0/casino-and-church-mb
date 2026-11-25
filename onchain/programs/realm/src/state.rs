use anchor_lang::prelude::*;

// ---------------------------------------------------------------- L1 only, never delegated

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub version: u8,
    pub admin: Pubkey,
    pub pending_admin: Pubkey,
    /// the AI hosts' keys
    pub fortuna: Pubkey,
    pub nakamoto: Pubkey,
    /// co-signs campaign approvals and claims
    pub church_oracle: Pubkey,
    /// may tick the market when the crank is late, and checkpoint
    pub keeper: Pubkey,
    /// the only rollup validator anything is delegated to
    pub er_validator: Pubkey,
    pub btc_feed: Pubkey,
    /// the exact Hydra crank allowed to tick the market
    pub market_crank: Pubkey,
    pub deposits_paused: bool,
    pub payouts_paused: bool,
    pub min_deposit: u64,
    pub max_deposit: u64,
    pub payout_cap_player_day: u64,
    pub payout_cap_global_hour: u64,
    pub bump: u8,
    pub spare: [u8; 64],
}

/// Holds all the SOL. `total_*` only go up.
#[account]
#[derive(InitSpace)]
pub struct Bank {
    pub total_deposited: u64,
    pub total_paid: u64,
    pub hour_id: i64,
    pub paid_this_hour: u64,
    pub bump: u8,
}

/// One per player, on L1. NEVER closed and NEVER delegated: its totals are what stop a double credit.
#[account]
#[derive(InitSpace)]
pub struct Purse {
    pub owner: Pubkey,
    /// lamports ever deposited; only goes up
    pub deposited: u64,
    /// lamports ever paid out; only goes up
    pub paid_out: u64,
    pub last_deposit_ts: i64,
    pub day_id: i64,
    pub paid_today: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct HousePurse {
    pub vault: u64,
    pub treasury: u64,
    pub jackpot: u64,
    pub bump: u8,
}

// ---------------------------------------------------------------- delegated to the rollup

#[zero_copy]
#[repr(C)]
#[derive(Debug, PartialEq, Eq)]
pub struct Params {
    pub luck_per_chip_milli: u32,
    pub luck_per_bet_cap_milli: u32,
    pub decay_per_min_milli: u32,
    pub max_decay_window_s: u32,
    pub offer_ratio_bps: u32,
    pub candle_cooldown_s: u32,
    pub harmony_cooldown_s: u32,
    pub harmony_cost_milli: u32,
    pub welcome_grant_chips: u32,
    pub max_bet_chips: u32,
    pub bet_timeout_s: u32,
    pub bj_idle_s: u32,
    pub blessing_day_cap_bps: u32,
    pub welcome_cap_total_chips: u32,
    pub promo_day_cap_chips: u32,
    pub promo_player_cap_chips: u32,
    pub candle_faith_milli: u32,
    pub _pad: u32,
    /// 0 = empty slot
    pub allowed_wagers: [u32; 8],
}

impl Params {
    /// the live NEAR testnet values
    pub fn launch() -> Self {
        Self {
            luck_per_chip_milli: 80,
            luck_per_bet_cap_milli: 8_000,
            decay_per_min_milli: 500,
            max_decay_window_s: 900,
            offer_ratio_bps: 8_000,
            candle_cooldown_s: 15,
            harmony_cooldown_s: 120,
            harmony_cost_milli: 20_000,
            welcome_grant_chips: 30,
            max_bet_chips: 10,
            bet_timeout_s: 180,
            bj_idle_s: 120,
            blessing_day_cap_bps: 500,
            welcome_cap_total_chips: 25_000,
            promo_day_cap_chips: 1_000,
            promo_player_cap_chips: 200,
            candle_faith_milli: 3_000,
            _pad: 0,
            allowed_wagers: [10, 0, 0, 0, 0, 0, 0, 0],
        }
    }
}

#[zero_copy]
#[repr(C)]
pub struct TimedEvent {
    pub started: i64,
    pub ends: i64,
    pub boost_bps: u32,
    pub active: u32,
}

#[account(zero_copy)]
#[repr(C)]
pub struct House {
    // pools (lamports)
    pub vault: u64,
    pub reserved: u64,
    pub treasury: u64,
    pub jackpot: u64,
    pub machine_total: u64,
    pub machine_reserved: u64,
    pub escrow_total: u64,
    pub chips_outstanding: u64,
    // bridge totals; only go up
    pub credited_vault: u64,
    pub credited_treasury: u64,
    pub credited_jackpot: u64,
    pub total_credited: u64,
    pub total_withdrawn: u64,
    // caps
    pub welcome_paid: u64,
    pub promo_day: i64,
    pub promo_spent: u64,
    pub blessing_day: i64,
    pub blessing_spent: u64,
    pub blessing_cap: u64,
    // hosts
    pub events: [TimedEvent; 2],
    pub last_event_start: [i64; 2],
    pub events_day: i64,
    pub events_today: [u32; 2],
    pub alms_day: i64,
    pub alms_base: u64,
    pub alms_spent: u64,
    pub topup_day: i64,
    pub topup_spent: u64,
    pub last_agent_change: i64,
    pub last_priest_change: i64,
    /// decisions already acted on (ring), so one decision acts once
    pub used_decisions: [[u8; 32]; 16],
    pub used_head: u64,
    pub params: Params,
    pub total_players: u64,
    pub paused: u8,
    pub bump: u8,
    pub version: u8,
    pub _pad: [u8; 5],
    /// free chips in players' hands (not part of the books: nothing has been paid for them)
    pub bonus_outstanding: u64,
    pub spare: [u8; 248],
}

#[zero_copy]
#[repr(C)]
pub struct PendingBet {
    pub seq: u64,
    pub wager: u64,
    pub hold: u64,
    pub max_payout: u64,
    pub placed_ts: i64,
    pub client_seed: [u8; 32],
    pub game: u8,
    pub pick: u8,
    /// 0 = the house; 1..=3 a machine on that plot
    pub plot: u8,
    pub active: u8,
    pub blessing_bps: u16,
    /// how many chips of the stake were free ones
    pub bonus_chips: u16,
}

/// Blackjack hand. Dealt cards are a 52-bit mask, so every draw is without replacement.
#[zero_copy]
#[repr(C)]
pub struct Hand {
    pub seq: u64,
    pub stake: u64,
    pub original: u64,
    pub hold: u64,
    pub last_ts: i64,
    pub used: u64,
    pub player: [u8; 12],
    pub dealer: [u8; 12],
    pub n_player: u8,
    pub n_dealer: u8,
    pub stage: u8,
    pub doubled: u8,
    /// what the pending VRF answer is for; 0 = nothing pending
    pub awaiting: u8,
    /// how many chips of the stake were free ones
    pub bonus_chips: u8,
    pub blessing_bps: u16,
}

#[zero_copy]
#[repr(C)]
pub struct BtcSlot {
    pub epoch: u64,
    pub wager: u64,
    pub seq: u64,
    pub payout_bps: u16,
    pub blessing_bps: u16,
    pub side: u8,
    /// 0 = free, 1 = placed
    pub state: u8,
    /// how many chips of the stake were free ones
    pub bonus_chips: u8,
    pub _pad: u8,
}

#[zero_copy]
#[repr(C)]
pub struct BetResult {
    pub seq: u64,
    pub wager: u64,
    pub payout: u64,
    pub ts: u32,
    pub luck_gain_milli: u32,
    pub outcome: [u8; 4],
    /// hundredths of a chip
    pub blessing_centi: u16,
    pub game: u8,
    /// 1 jackpot, 2 the prize was free chips
    pub flags: u8,
}

#[zero_copy]
#[repr(C)]
pub struct MachinePlays {
    pub machine_id: u32,
    pub plays: u32,
}

/// NEVER closed: `credited` living here, next to `chips`, is what makes a double credit impossible.
#[account(zero_copy)]
#[repr(C)]
pub struct Player {
    pub authority: Pubkey,
    // money (lamports)
    pub chips: u64,
    /// how much of Purse.deposited has become chips; only goes up
    pub credited: u64,
    /// lamports ever cashed out; only goes up, and Purse.paid_out follows it
    pub withdrawn: u64,
    /// how much of `withdrawn` the House's books know about (a cash-out on L1 is booked at the next rollup action)
    pub withdrawn_booked: u64,
    // clocks (unix seconds)
    pub last_update: i64,
    pub last_realm_change: i64,
    pub candle_at: i64,
    pub harmony_at: i64,
    pub last_alms: i64,
    // lifetime stats
    pub wagered: u64,
    pub tithed: u64,
    pub converted_milli: u64,
    pub faith_earned_milli: u64,
    pub promo_today: u64,
    pub bet_seq: u64,
    pub luck_milli: u32,
    pub faith_milli: u32,
    pub quests_claimed: u32,
    pub promo_day: u32,
    pub campaign_faith_day: u32,
    pub campaign_faith_used: u32,
    pub spins: u32,
    pub flips: u32,
    pub dice: u32,
    pub roulette: u32,
    pub blackjack: u32,
    pub candles: u32,
    pub timeouts: u32,
    /// commits since the last delegation
    pub commits: u32,
    /// 0 plaza, 1 casino, 2 church
    pub realm: u8,
    pub tour_flags: u8,
    pub flags: u8,
    pub bump: u8,
    pub recent_head: u8,
    pub version: u8,
    pub _pad: [u8; 2],
    pub name: [u8; 16],
    pub avatar: [u8; 24],
    pub campaigns: [u8; 32],
    pub machine_plays: [MachinePlays; 3],
    pub pending: PendingBet,
    pub hand: Hand,
    pub btc: [BtcSlot; 8],
    pub recent: [BetResult; 8],
    /// the randomness that settled the last bet, so anybody can check it
    pub last_vrf: [u8; 32],
    pub last_vrf_seq: u64,
    /// free chips (lamports): for playing only. Never cashed out, never a debt: the vault pays when one WINS
    pub bonus: u64,
    pub spare: [u8; 72],
}

/// a round that is taking bets, or being decided
#[zero_copy]
#[repr(C)]
#[derive(Debug, PartialEq, Eq)]
pub struct LiveRound {
    pub epoch: u64,
    pub open_ts: i64,
    /// betting closes here, and the price that locks the round must be from this second or later
    pub lock_ts: i64,
    pub locked_at: i64,
    /// lamports on each side
    pub up: u64,
    pub down: u64,
    pub bets: u32,
    /// US cents
    pub lock_c: u32,
}

/// a finished round, in full
#[zero_copy]
#[repr(C)]
#[derive(Debug, PartialEq, Eq)]
pub struct RoundRec {
    pub epoch: u32,
    pub lock_c: u32,
    pub close_c: u32,
    pub closed_ts: u32,
    pub up_chips: u32,
    pub down_chips: u32,
    pub bets: u16,
    /// 1 up, 2 down, 3 tie, 4 void
    pub outcome: u8,
    /// seconds after the minute was up
    pub late_s: u8,
}
pub const RING: u64 = 240;
pub const ARCHIVE_ROUNDS: u64 = 10_080;

#[account(zero_copy)]
#[repr(C)]
pub struct Market {
    pub open: LiveRound,
    /// epoch 0 = none
    pub live: LiveRound,
    pub round_s: u32,
    pub grace_s: u32,
    pub payout_bps: u32,
    /// commits since the last delegation
    pub commits: u32,
    pub wagers: [u32; 8],
    pub closed: u64,
    pub voided: u64,
    pub crank_ticks: u64,
    pub keeper_prices: u64,
    pub last_tick_ts: i64,
    pub last_price_ts: i64,
    pub last_price_c: u32,
    pub max_gap_s: u32,
    pub enabled: u8,
    pub bump: u8,
    pub version: u8,
    pub _pad: [u8; 5],
    pub spare: [u8; 120],
    /// the last 240 rounds (4 hours), by epoch % 240
    pub rounds: [RoundRec; 240],
    /// 2 bits a round for a week, by epoch % 10,080: 1 up, 2 down, 3 bet returned
    pub archive: [u8; 2_520],
}
impl Market {
    pub const SPACE: usize = 8 + std::mem::size_of::<Market>();
}

/// Founders' Row
#[zero_copy]
#[repr(C)]
pub struct Machine {
    pub owner: Pubkey,
    pub bankroll: u64,
    pub reserved: u64,
    pub plays: u64,
    pub earned: i64,
    pub name: [u8; 16],
    /// 0 = an empty plot
    pub id: u32,
    pub skin: u8,
    pub _pad: [u8; 3],
}
#[account(zero_copy)]
#[repr(C)]
pub struct Plots {
    pub machines: [Machine; 3],
    pub next_id: u32,
    pub bump: u8,
    pub _pad: [u8; 3],
    pub spare: [u8; 256],
}
impl Plots {
    pub const SPACE: usize = 8 + std::mem::size_of::<Plots>();
}

pub const BOARD_SLOTS: usize = 20;
/// campaigns a board can ever have: their ids are bits in `Player.campaigns`
pub const BOARD_IDS: u32 = 128;
#[zero_copy]
#[repr(C)]
pub struct Campaign {
    pub creator: Pubkey,
    /// lamports not yet given out (or collected)
    pub budget: u64,
    pub created: i64,
    pub id: u32,
    pub machine_id: u32,
    pub goal: u32,
    pub reward_chips: u32,
    pub reward_faith_milli: u32,
    pub max_claims: u32,
    pub claims: u32,
    pub kind: u8,
    pub active: u8,
    pub from_treasury: u8,
    pub title_len: u8,
    pub url_len: u8,
    pub _pad: [u8; 3],
    pub title: [u8; 60],
    pub url: [u8; 160],
}
#[account(zero_copy)]
#[repr(C)]
pub struct Board {
    pub slots: [Campaign; BOARD_SLOTS],
    pub next: u32,
    pub index: u8,
    pub bump: u8,
    pub _pad: [u8; 2],
    pub spare: [u8; 64],
}
impl Board {
    pub const SPACE: usize = 8 + std::mem::size_of::<Board>();
}

impl Player {
    pub const SPACE: usize = 8 + std::mem::size_of::<Player>();
    /// a VRF answer is on its way (or a blackjack hand is open)
    pub fn busy(&self) -> bool {
        self.pending.active != 0 || self.hand.stage != 0 || self.hand.awaiting != 0
    }
}
impl House {
    pub const SPACE: usize = 8 + std::mem::size_of::<House>();
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::constants::MAX_COMMITTABLE;

    #[test]
    fn layouts_are_what_the_client_decodes() {
        assert_eq!(std::mem::size_of::<PendingBet>(), 80);
        assert_eq!(std::mem::size_of::<Hand>(), 80);
        assert_eq!(std::mem::size_of::<BtcSlot>(), 32);
        assert_eq!(std::mem::size_of::<BetResult>(), 40);
        assert_eq!(Player::SPACE, 8 + 1168);
        assert_eq!((std::mem::size_of::<LiveRound>(), std::mem::size_of::<RoundRec>()), (56, 28));
        assert_eq!(Market::SPACE, 8 + 344 + 240 * 28 + 2_520);
        assert!(Market::SPACE <= MAX_COMMITTABLE);
        assert_eq!((std::mem::size_of::<Machine>(), Plots::SPACE), (88, 8 + 264 + 8 + 256));
        assert_eq!((std::mem::size_of::<Campaign>(), Board::SPACE), (304, 8 + 20 * 304 + 8 + 64));
        assert!(Board::SPACE <= MAX_COMMITTABLE);
        // the rollup refuses to commit anything bigger
        assert!(Player::SPACE <= MAX_COMMITTABLE && House::SPACE <= MAX_COMMITTABLE);
    }
}
