//! Placing, settling and refunding a bet. Pure: no accounts, no CPI.
//!
//! Place:  player -wager, vault +wager, reserve the most it can pay.
//! Settle: release the reserve, send the church and jackpot their share, pay the player.
//! Refund: the exact reverse of placing. Shares are taken when a bet SETTLES, so a refund never has to take them back.

use crate::constants::{CHIP, DAY_S, LUCK_WEIGHT, METER_MAX};
use crate::games::*;
use crate::money::{grant_bonus, pay_bet, return_stake, take_stake, vault_free};
use crate::state::{BetResult, House, PendingBet, Player};

pub const TREASURY_BPS: u64 = 50;
pub const JACKPOT_BPS: u64 = 25;
pub const JACKPOT_FLOOR: u64 = 150 * CHIP;

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum BetError {
    Busy,
    BadPick,
    BadWager,
    MaxBet,
    NoChips,
    LuckLow,
    FaithLow,
    Cooldown,
    VaultLow,
    NothingPending,
    TooEarly,
    Overflow,
    NoHand,
    CannotDouble,
}
type R<T> = core::result::Result<T, BetError>;

pub fn bps(amount: u64, b: u64) -> u64 {
    (u128::from(amount) * u128::from(b) / 10_000) as u64
}
pub fn wager_allowed(h: &House, chips: u64) -> R<()> {
    if chips == 0 || !h.params.allowed_wagers.iter().any(|w| *w != 0 && u64::from(*w) == chips) {
        return Err(BetError::BadWager);
    }
    if chips > u64::from(h.params.max_bet_chips) || chips > vault_free(h) / CHIP / 200 {
        return Err(BetError::MaxBet);
    }
    Ok(())
}

pub fn place(p: &mut Player, h: &mut House, game: u8, chips: u64, pick: u8, client_seed: [u8; 32], now: i64) -> R<u64> {
    if p.busy() {
        return Err(BetError::Busy);
    }
    if game > HARMONY || !valid_pick(game, pick) {
        return Err(BetError::BadPick);
    }
    let wager = chips.checked_mul(CHIP).ok_or(BetError::Overflow)?;
    let cost = harmony_cost(h);
    match game {
        WHEEL => {
            if chips != 0 { return Err(BetError::BadWager); }
            if p.luck_milli < METER_MAX { return Err(BetError::LuckLow); }
        }
        HARMONY => {
            if chips != 0 { return Err(BetError::BadWager); }
            if p.luck_milli < cost { return Err(BetError::LuckLow); }
            if p.faith_milli < cost { return Err(BetError::FaithLow); }
            if now < p.harmony_at + i64::from(h.params.harmony_cooldown_s) { return Err(BetError::Cooldown); }
        }
        _ => {
            wager_allowed(h, chips)?;
            if p.chips.saturating_add(p.bonus / CHIP * CHIP) < wager { return Err(BetError::NoChips); }
        }
    }
    let max = max_payout(game, wager);
    // the real part of the bet itself counts towards covering it
    let real = wager - (p.bonus / CHIP).min(chips) * CHIP;
    if h.vault.checked_add(real).ok_or(BetError::Overflow)? < h.reserved.checked_add(max).ok_or(BetError::Overflow)? {
        return Err(BetError::VaultLow);
    }
    let blessing = blessing_bps(p.faith_milli);
    let bonus = take_stake(p, h, wager).ok_or(BetError::NoChips)?;
    h.reserved += max;
    match game {
        WHEEL => p.luck_milli -= METER_MAX,
        HARMONY => {
            p.luck_milli -= cost;
            p.faith_milli -= cost;
            p.harmony_at = now;
        }
        _ => {}
    }
    p.bet_seq += 1;
    p.pending = PendingBet { seq: p.bet_seq, wager, hold: max, max_payout: max, placed_ts: now, client_seed, game, pick, plot: 0, active: 1, blessing_bps: blessing, bonus_chips: u16::from(bonus) };
    Ok(p.bet_seq)
}

/// What the chain asks the oracle to use: the player's bytes, the player, and the bet, so nobody picks it alone.
pub fn caller_seed(client_seed: &[u8; 32], player: &[u8; 32], seq: u64) -> [u8; 32] {
    let mut s = *client_seed;
    for i in 0..32 { s[i] ^= player[i]; }
    for (i, b) in seq.to_le_bytes().iter().enumerate() { s[i] ^= b; }
    s
}

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub struct Settled {
    pub seq: u64,
    pub game: u8,
    pub pick: u8,
    pub wager: u64,
    pub payout: u64,
    pub blessing: u64,
    pub luck_gain_milli: u32,
    pub outcome: [u8; 4],
    pub jackpot: bool,
}

/// Harmony spends half of each meter, never less
pub fn harmony_cost(h: &House) -> u32 {
    h.params.harmony_cost_milli.max(METER_MAX / 2)
}
/// `real`: lamports of real chips in the bet. Free chips earn no LUCK.
pub fn luck_award(h: &House, game: u8, real: u64, now: i64) -> u32 {
    let weight = LUCK_WEIGHT.get(usize::from(game)).copied().unwrap_or(0);
    let mut raw = (u128::from(real) * u128::from(h.params.luck_per_chip_milli) * u128::from(weight) / 100 / u128::from(CHIP)) as u64;
    let mut cap = u64::from(h.params.luck_per_bet_cap_milli);
    let e = &h.events[0];
    if e.active != 0 && now < e.ends {
        raw = raw.saturating_mul(10_000 + u64::from(e.boost_bps)) / 10_000;
        cap = cap * 3 / 2;
    }
    raw.min(cap) as u32
}
pub fn add_luck(p: &mut Player, gain: u32) -> u32 {
    let applied = gain.min(METER_MAX - p.luck_milli.min(METER_MAX));
    p.luck_milli += applied;
    applied
}
/// From the treasury, within the day's cap.
pub fn take_blessing(h: &mut House, base: u64, b: u16, now: i64) -> u64 {
    let want = bps(base, u64::from(b));
    if want == 0 { return 0; }
    let day = now.div_euclid(DAY_S);
    if h.blessing_day != day {
        h.blessing_day = day;
        h.blessing_spent = 0;
        h.blessing_cap = bps(h.treasury, u64::from(h.params.blessing_day_cap_bps));
    }
    let give = want.min(h.blessing_cap.saturating_sub(h.blessing_spent)).min(h.treasury);
    h.treasury -= give;
    h.blessing_spent += give;
    give
}

/// None when this answer is for nothing we are waiting for (late, repeated, or already refunded): then nothing changes.
pub fn settle(p: &mut Player, h: &mut House, randomness: &[u8; 32], seq: u64, now: i64) -> Option<Settled> {
    let b = p.pending;
    if b.active == 0 || b.seq != seq || b.plot != 0 { return None; }
    p.pending = PendingBet { active: 0, ..bytemuck::Zeroable::zeroed() }; // first: a repeat finds nothing
    h.reserved = h.reserved.saturating_sub(b.hold);
    let r = resolve(b.game, &draws_of(randomness), b.pick, b.wager);
    let free = u64::from(b.bonus_chips);
    let real_stake = b.wager.saturating_sub(free * CHIP);
    // the church's and the jackpot's share of the real stake
    let (t, j) = (bps(real_stake, TREASURY_BPS).min(h.vault), bps(real_stake, JACKPOT_BPS));
    h.vault -= t;
    h.treasury += t;
    let j = j.min(h.vault);
    h.vault -= j;
    h.jackpot += j;
    let (total, blessing) = if r.jackpot {
        let mut pot = h.jackpot;
        h.jackpot = 0;
        let top = JACKPOT_FLOOR.saturating_sub(pot).min(vault_free(h));
        h.vault -= top;
        pot += top;
        // whole chips only; the dust stays in the pot
        let pay = pot / CHIP * CHIP;
        h.jackpot = pot - pay;
        p.chips += pay;
        h.chips_outstanding += pay;
        (pay, 0)
    } else if is_meter_game(b.game) {
        grant_bonus(p, h, r.base).ok()?;
        (r.base, 0)
    } else {
        let (total, real) = pay_bet(p, h, b.wager, free, r.base);
        let blessing = take_blessing(h, real, b.blessing_bps, now);
        p.chips += blessing;
        h.chips_outstanding += blessing;
        (total, blessing)
    };
    let payout = total + blessing;
    let luck = add_luck(p, luck_award(h, b.game, real_stake, now));
    match b.game {
        SLOTS => p.spins = p.spins.saturating_add(1),
        COIN => p.flips = p.flips.saturating_add(1),
        DICE => p.dice = p.dice.saturating_add(1),
        ROULETTE => p.roulette = p.roulette.saturating_add(1),
        _ => {}
    }
    p.wagered = p.wagered.saturating_add(b.wager);
    p.last_vrf = *randomness;
    p.last_vrf_seq = seq;
    record(p, seq, b.wager, payout, now, luck, r.outcome, blessing, b.game, u8::from(r.jackpot) | if is_meter_game(b.game) && !r.jackpot { 2 } else { 0 });
    Some(Settled { seq, game: b.game, pick: b.pick, wager: b.wager, payout, blessing, luck_gain_milli: luck, outcome: r.outcome, jackpot: r.jackpot })
}

/// into the ring of the last eight results, where the client reads it
#[allow(clippy::too_many_arguments)]
pub fn record(p: &mut Player, seq: u64, wager: u64, payout: u64, now: i64, luck_gain_milli: u32, outcome: [u8; 4], blessing: u64, game: u8, flags: u8) {
    let i = usize::from(p.recent_head) % p.recent.len();
    p.recent[i] = BetResult { seq, wager, payout, ts: now as u32, luck_gain_milli, outcome, blessing_centi: (blessing / (CHIP / 100)).min(u64::from(u16::MAX)) as u16, game, flags };
    p.recent_head = ((i + 1) % p.recent.len()) as u8;
}

/// The oracle never answered. Everything the bet took comes back.
pub fn refund(p: &mut Player, h: &mut House, now: i64) -> R<(u64, u64)> {
    let b = p.pending;
    if b.active == 0 || b.plot != 0 { return Err(BetError::NothingPending); }
    if now < b.placed_ts + i64::from(h.params.bet_timeout_s) { return Err(BetError::TooEarly); }
    p.pending = PendingBet { active: 0, ..bytemuck::Zeroable::zeroed() };
    h.reserved = h.reserved.saturating_sub(b.hold);
    return_stake(p, h, b.wager, u64::from(b.bonus_chips)).map_err(|_| BetError::Overflow)?;
    match b.game {
        WHEEL => p.luck_milli = METER_MAX,
        HARMONY => {
            p.luck_milli = (p.luck_milli + harmony_cost(h)).min(METER_MAX);
            p.faith_milli = (p.faith_milli + harmony_cost(h)).min(METER_MAX);
            p.harmony_at = 0;
        }
        _ => {}
    }
    p.timeouts = p.timeouts.saturating_add(1);
    Ok((b.seq, b.wager))
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use crate::money::liabilities;
    use crate::state::Params;
    pub fn rig(vault_chips: u64, chips: u64) -> (Player, House) {
        let mut p: Player = bytemuck::Zeroable::zeroed();
        let mut h: House = bytemuck::Zeroable::zeroed();
        h.params = Params::launch();
        h.vault = vault_chips * CHIP;
        h.treasury = 250 * CHIP;
        h.jackpot = 200 * CHIP;
        p.chips = chips * CHIP;
        h.chips_outstanding = chips * CHIP;
        h.total_credited = h.vault + h.treasury + h.jackpot + p.chips;
        (p, h)
    }
    pub fn balanced(h: &House) { assert_eq!(liabilities(h), u128::from(h.total_credited - h.total_withdrawn)); }
    fn heads() -> [u8; 32] { [0; 32] }
    fn tails() -> [u8; 32] { [0xff; 32] }

    #[test]
    fn a_win_a_loss_and_the_shares() {
        let (mut p, mut h) = rig(5_000, 30);
        let s = place(&mut p, &mut h, COIN, 10, 0, [1; 32], 100).unwrap();
        assert_eq!((p.chips, h.reserved), (20 * CHIP, 19_400_000));
        let r = settle(&mut p, &mut h, &heads(), s, 101).unwrap();
        assert_eq!((r.payout, p.chips, h.reserved, p.flips, p.wagered), (19_400_000, 39_400_000, 0, 1, 10 * CHIP));
        assert_eq!((h.treasury, h.jackpot), (250 * CHIP + 50_000, 200 * CHIP + 25_000));
        assert_eq!(p.luck_milli, 400);
        balanced(&h);
        let s = place(&mut p, &mut h, COIN, 10, 0, [1; 32], 102).unwrap();
        assert_eq!(settle(&mut p, &mut h, &tails(), s, 103).unwrap().payout, 0);
        assert_eq!(p.chips, 29_400_000);
        balanced(&h);
    }

    #[test]
    fn late_repeated_and_foreign_answers_change_nothing() {
        let (mut p, mut h) = rig(5_000, 30);
        let s = place(&mut p, &mut h, COIN, 10, 0, [1; 32], 0).unwrap();
        assert!(settle(&mut p, &mut h, &heads(), s + 1, 1).is_none());
        assert!(settle(&mut p, &mut h, &heads(), s, 1).is_some());
        let (a, b) = (p.chips, h.vault);
        assert!(settle(&mut p, &mut h, &heads(), s, 2).is_none());
        assert_eq!((p.chips, h.vault), (a, b));
        // refunded, then the answer turns up
        let s = place(&mut p, &mut h, COIN, 10, 0, [1; 32], 10).unwrap();
        assert_eq!(refund(&mut p, &mut h, 100), Err(BetError::TooEarly));
        refund(&mut p, &mut h, 190).unwrap();
        let a = p.chips;
        assert!(settle(&mut p, &mut h, &heads(), s, 191).is_none());
        assert_eq!(refund(&mut p, &mut h, 999), Err(BetError::NothingPending));
        assert_eq!((p.chips, h.reserved), (a, 0));
        balanced(&h);
    }

    #[test]
    fn what_a_table_refuses() {
        let (mut p, mut h) = rig(5_000, 30);
        for (g, c, k, e) in [(COIN, 10, 2, BetError::BadPick), (BLACKJACK, 10, 0, BetError::BadPick), (MARKET, 10, 0, BetError::BadPick), (COIN, 11, 0, BetError::BadWager), (COIN, 0, 0, BetError::BadWager), (WHEEL, 0, 0, BetError::LuckLow), (WHEEL, 10, 0, BetError::BadWager), (HARMONY, 0, 0, BetError::LuckLow)] {
            assert_eq!(place(&mut p, &mut h, g, c, k, [0; 32], 0), Err(e), "{g} {c} {k}");
        }
        assert_eq!(place(&mut p, &mut h, COIN, u64::MAX, 0, [0; 32], 0), Err(BetError::Overflow));
        place(&mut p, &mut h, COIN, 10, 0, [0; 32], 0).unwrap();
        assert_eq!(place(&mut p, &mut h, COIN, 10, 0, [0; 32], 0), Err(BetError::Busy));
        let (mut p, mut h) = rig(5_000, 9);
        assert_eq!(place(&mut p, &mut h, COIN, 10, 0, [0; 32], 0), Err(BetError::NoChips));
        let (mut p, mut h) = rig(1_999, 30);
        assert_eq!(place(&mut p, &mut h, COIN, 10, 0, [0; 32], 0), Err(BetError::MaxBet));
        let (mut p, mut h) = rig(5_000, 30);
        h.reserved = h.vault - 2_000 * CHIP; // the table is open, but a slots jackpot is 1,000 chips on top of everything held
        place(&mut p, &mut h, SLOTS, 10, 0, [0; 32], 0).unwrap();
        let (mut p2, _) = rig(0, 30);
        h.chips_outstanding += p2.chips;
        assert_eq!(place(&mut p2, &mut h, SLOTS, 10, 0, [0; 32], 0), Err(BetError::MaxBet));
    }

    #[test]
    fn wheels_spend_meters_and_give_them_back_on_a_refund() {
        let (mut p, mut h) = rig(5_000, 30);
        p.luck_milli = METER_MAX;
        let s = place(&mut p, &mut h, WHEEL, 0, 0, [0; 32], 0).unwrap();
        assert_eq!((p.luck_milli, p.chips), (0, 30 * CHIP));
        refund(&mut p, &mut h, 1_000).unwrap();
        assert_eq!(p.luck_milli, METER_MAX);
        assert!(settle(&mut p, &mut h, &heads(), s, 1_001).is_none());
        let s = place(&mut p, &mut h, WHEEL, 0, 0, [0; 32], 1_002).unwrap();
        assert_eq!(settle(&mut p, &mut h, &heads(), s, 1_003).unwrap().payout, 10 * CHIP);
        assert_eq!((p.chips, p.bonus, h.bonus_outstanding), (30 * CHIP, 10 * CHIP, 10 * CHIP), "the wheel pays free chips");
        p.luck_milli = 60_000;
        p.faith_milli = 60_000;
        let s = place(&mut p, &mut h, HARMONY, 0, 0, [0; 32], 2_000).unwrap();
        assert_eq!((p.luck_milli, p.faith_milli, h.reserved), (10_000, 10_000, 0));
        let j = settle(&mut p, &mut h, &tails(), s, 2_001).unwrap();
        assert!(j.jackpot);
        assert_eq!((h.jackpot, p.chips), (0, 30 * CHIP + j.payout), "the jackpot is real");
        p.luck_milli = 60_000;
        p.faith_milli = 60_000;
        assert_eq!(place(&mut p, &mut h, HARMONY, 0, 0, [0; 32], 2_100), Err(BetError::Cooldown));
        balanced(&h);
    }

    #[test]
    fn blessings_come_from_the_treasury_within_the_cap() {
        let (mut p, mut h) = rig(5_000, 400);
        p.faith_milli = METER_MAX; // saint: +3%
        h.params.allowed_wagers[0] = 10;
        let before = h.treasury;
        let t0 = 10 * DAY_S;
        let s = place(&mut p, &mut h, ROULETTE, 10, 0, [0; 32], t0).unwrap(); // straight-up on 0
        let r = settle(&mut p, &mut h, &heads(), s, t0 + 1).unwrap(); // lands on 0: 360 chips, +10 blessing
        assert_eq!((r.payout, r.blessing), (370_800_000, 10_800_000));
        assert_eq!(h.treasury, before + 50_000 - 10_800_000);
        // the day's cap is 5% of the treasury's 250.05 chips, so 1.7025 are left
        let s = place(&mut p, &mut h, ROULETTE, 10, 0, [0; 32], t0 + 2).unwrap();
        assert_eq!(settle(&mut p, &mut h, &heads(), s, t0 + 3).unwrap().blessing, 1_702_500);
        let s = place(&mut p, &mut h, ROULETTE, 10, 0, [0; 32], t0 + DAY_S + 2).unwrap();
        assert!(settle(&mut p, &mut h, &heads(), s, t0 + DAY_S + 3).unwrap().blessing > 2 * CHIP);
        balanced(&h);
    }

    #[test]
    fn free_chips_go_first_and_only_a_win_makes_them_real() {
        let (mut p, mut h) = rig(5_000, 30);
        grant_bonus(&mut p, &mut h, 14 * CHIP).unwrap();
        let v = h.vault;
        // all free: nothing moves, and no LUCK
        let s = place(&mut p, &mut h, COIN, 10, 0, [0; 32], 0).unwrap();
        assert_eq!((p.chips, p.bonus, h.vault, p.pending.bonus_chips), (30 * CHIP, 4 * CHIP, v, 10));
        let r = settle(&mut p, &mut h, &tails(), s, 1).unwrap();
        assert_eq!((r.payout, p.chips, p.bonus, h.vault, p.luck_milli), (0, 30 * CHIP, 4 * CHIP, v, 0));
        balanced(&h);
        // 4 free and 6 real: a win pays it all in real chips, LUCK and the shares only for the 6
        let s = place(&mut p, &mut h, COIN, 10, 0, [0; 32], 2).unwrap();
        assert_eq!((p.chips, p.bonus, h.vault), (24 * CHIP, 0, v + 6 * CHIP));
        settle(&mut p, &mut h, &heads(), s, 3).unwrap();
        assert_eq!((p.chips, p.bonus, p.luck_milli, h.bonus_outstanding), (24 * CHIP + 19_400_000, 0, 240, 0));
        assert_eq!(h.treasury, 250 * CHIP + 30_000);
        balanced(&h);
        // a refund gives each part back
        grant_bonus(&mut p, &mut h, 3 * CHIP).unwrap();
        let c = p.chips;
        place(&mut p, &mut h, COIN, 10, 0, [0; 32], 4).unwrap();
        refund(&mut p, &mut h, 999).unwrap();
        assert_eq!((p.chips, p.bonus), (c, 3 * CHIP));
        // a returned stake (two matching slots) is not a win: the free part stays free
        let pair = { let mut b = [0u8; 32]; b[8..12].copy_from_slice(&[0xff; 4]); b }; // seven seven cross: 1x
        let s = place(&mut p, &mut h, SLOTS, 10, 0, [0; 32], 1_000).unwrap();
        assert_eq!(settle(&mut p, &mut h, &pair, s, 1_001).unwrap().payout, 10 * CHIP);
        assert_eq!((p.chips, p.bonus), (c, 3 * CHIP));
        balanced(&h);
        // the house must be able to cover a free bet without the stake
        let (mut p, mut h) = rig(2_000, 0);
        grant_bonus(&mut p, &mut h, 10 * CHIP).unwrap();
        h.reserved = 0;
        h.params.max_bet_chips = 10;
        assert!(place(&mut p, &mut h, SLOTS, 10, 0, [0; 32], 0).is_ok());
        assert_eq!(h.reserved, 1_000 * CHIP);
    }

    #[test]
    fn random_play_balances_and_the_vault_can_always_pay() {
        for seed in 1..=300u64 {
            let mut x = seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1;
            let mut next = || { x ^= x << 13; x ^= x >> 7; x ^= x << 17; x };
            let (mut p, mut h) = rig(4_000, 300);
            let mut now = 0i64;
            for _ in 0..200 {
                now += (next() % 90) as i64;
                let g = (next() % 6) as u8;
                if next() % 4 == 0 { grant_bonus(&mut p, &mut h, next() % 25 * CHIP).unwrap(); }
                if is_meter_game(g) { p.luck_milli = METER_MAX; p.faith_milli = METER_MAX; } else { p.faith_milli = (next() % 100_001) as u32; }
                let pick = match g { COIN => (next() % 2) as u8, DICE => (next() % 4) as u8, ROULETTE => [0u8, 17, 36, 100, 103, 111, 122][(next() % 7) as usize], _ => 0 };
                if let Ok(s) = place(&mut p, &mut h, g, if is_meter_game(g) { 0 } else { 10 }, pick, [0; 32], now) {
                    assert!(h.reserved <= h.vault, "seed {seed}: holds above the vault");
                    balanced(&h);
                    if next() % 12 == 0 { now += 200; refund(&mut p, &mut h, now).unwrap(); }
                    else { let mut rnd = [0u8; 32]; for c in rnd.chunks_mut(8) { c.copy_from_slice(&next().to_le_bytes()); } let r = settle(&mut p, &mut h, &rnd, s, now + 1).unwrap(); assert!(r.jackpot || is_meter_game(g) || r.payout - r.blessing <= max_payout(g, r.wager)); assert_eq!(p.bonus % CHIP, 0, "free chips are whole"); }
                }
                balanced(&h);
                assert_eq!((p.chips, p.bonus), (h.chips_outstanding, h.bonus_outstanding));
                assert!(!p.busy() && h.reserved == 0);
            }
        }
    }
}
