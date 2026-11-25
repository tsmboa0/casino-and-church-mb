//! The BTC market. Pure: no accounts, no CPI.
//!
//! Rounds run back to back and never stop. One price does three things: it closes the live round, locks the open one, and
//! opens the next. UP if close > lock, DOWN if close < lock, a tie or a void returns the bet. Fixed odds against the vault.
//!
//! A bet lives in the bettor's own account and a round only holds totals, so a round costs the same with 1 bettor or
//! 1,000. The last 240 rounds stay here in full (4 hours), and 2 bits of every round for a week.
//!
//! Bets close BEFORE the price that locks their round exists: the price must be published at or after the lock time.

use crate::bets::{add_luck, bps, luck_award, record, take_blessing, JACKPOT_BPS, TREASURY_BPS};
use crate::constants::CHIP;
use crate::games::{blessing_bps, MARKET};
use crate::money::vault_free;
use crate::state::{BtcSlot, House, LiveRound, Market, Player, RoundRec, ARCHIVE_ROUNDS, RING};

pub const UP: u8 = 1;
pub const DOWN: u8 = 2;
pub const TIE: u8 = 3;
pub const VOID: u8 = 4;
/// a price older than this (or from the future) is not used
pub const MAX_PRICE_AGE_S: i64 = 5;

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum MarketError {
    Closed,
    RoundMoved,
    RoundLocked,
    BadPick,
    BadWager,
    MaxBet,
    AlreadyBet,
    SlotsFull,
    NoChips,
    VaultLow,
    BadArgs,
    Overflow,
}
type R<T> = core::result::Result<T, MarketError>;

/// Pyth Lazer, as MagicBlock's oracle program writes it: price (i64, 1e-8 dollars) at 73, publish time at 93.
/// (US cents, publish time)
pub fn read_feed(d: &[u8]) -> Option<(u32, i64)> {
    if d.len() < 101 { return None; }
    let price = i64::from_le_bytes(d[73..81].try_into().ok()?);
    let publish = i64::from_le_bytes(d[93..101].try_into().ok()?);
    if price <= 0 { return None; }
    Some((u32::try_from(price.checked_add(500_000)? / 1_000_000).ok()?, publish))
}
pub fn usable(price: Option<(u32, i64)>, lock_ts: i64, now: i64) -> Option<(u32, i64)> {
    price.filter(|(c, t)| *c > 0 && *t >= lock_ts && (now - *t).abs() <= MAX_PRICE_AGE_S)
}

fn open_round(m: &mut Market, epoch: u64, now: i64) {
    m.open = LiveRound { epoch, open_ts: now, lock_ts: now + i64::from(m.round_s), ..bytemuck::Zeroable::zeroed() };
}
fn bits(outcome: u8) -> u8 {
    match outcome { UP => 1, DOWN => 2, _ => 3 }
}
fn archive_at(epoch: u64) -> (usize, u32) {
    let i = (epoch % ARCHIVE_ROUNDS) as usize;
    (i / 4, (i % 4) as u32 * 2)
}
fn finish(m: &mut Market, r: LiveRound, outcome: u8, close_c: u32, now: i64) -> RoundRec {
    let late = (now - r.lock_ts - i64::from(m.round_s)).clamp(0, 255) as u8;
    let rec = RoundRec {
        epoch: r.epoch as u32,
        lock_c: r.lock_c,
        close_c,
        closed_ts: now as u32,
        up_chips: (r.up / CHIP).min(u64::from(u32::MAX)) as u32,
        down_chips: (r.down / CHIP).min(u64::from(u32::MAX)) as u32,
        bets: r.bets.min(u32::from(u16::MAX)) as u16,
        outcome,
        late_s: if outcome == VOID { 0 } else { late },
    };
    m.rounds[(r.epoch % RING) as usize] = rec;
    let (i, s) = archive_at(r.epoch);
    m.archive[i] = (m.archive[i] & !(3 << s)) | (bits(outcome) << s);
    if outcome == VOID { m.voided += 1 } else { m.closed += 1 }
    rec
}

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum Tick {
    /// nothing due
    Idle,
    /// no usable price yet: try again next second
    NoPrice,
    /// due, but this caller may not price a round
    NotAllowed,
    Voided { live: Option<RoundRec>, open: RoundRec },
    Priced { closed: Option<RoundRec>, locked: u64, price_c: u32 },
}

/// `may_price`: the crank or the keeper. Once the grace is over, anyone may call it, and then it can only void.
pub fn tick(m: &mut Market, price: Option<(u32, i64)>, may_price: bool, now: i64) -> Tick {
    if m.enabled == 0 || m.open.epoch == 0 || now < m.open.lock_ts { return Tick::Idle; }
    if now > m.open.lock_ts + i64::from(m.grace_s) { return void_all(m, now); }
    if !may_price { return Tick::NotAllowed; }
    let Some((cents, publish)) = usable(price, m.open.lock_ts, now) else { return Tick::NoPrice };
    let live = m.live;
    let closed = (live.epoch != 0).then(|| {
        let outcome = if cents > live.lock_c { UP } else if cents < live.lock_c { DOWN } else { TIE };
        finish(m, live, outcome, cents, now)
    });
    let locked = m.open.epoch;
    m.live = LiveRound { lock_c: cents, locked_at: now, ..m.open };
    m.last_price_c = cents;
    m.last_price_ts = publish;
    open_round(m, locked + 1, now);
    Tick::Priced { closed, locked, price_c: cents }
}
pub fn void_all(m: &mut Market, now: i64) -> Tick {
    let (live, open) = (m.live, m.open);
    let a = (live.epoch != 0).then(|| finish(m, live, VOID, 0, now));
    let b = finish(m, open, VOID, 0, now);
    m.live = bytemuck::Zeroable::zeroed();
    open_round(m, open.epoch + 1, now);
    Tick::Voided { live: a, open: b }
}

pub fn start(m: &mut Market, now: i64) {
    if m.enabled != 0 { return; }
    // nobody can have bet on the round waiting here: betting was off
    open_round(m, m.open.epoch.max(1), now);
    m.enabled = 1;
}
/// Rounds still running are void, so every bet comes back.
pub fn stop(m: &mut Market, now: i64) -> Option<Tick> {
    if m.enabled == 0 { return None; }
    let t = void_all(m, now);
    m.enabled = 0;
    Some(t)
}

pub fn hold_of(wager: u64, payout_bps: u16) -> u64 {
    bps(wager, u64::from(payout_bps))
}

pub fn bet(p: &mut Player, h: &mut House, m: &mut Market, epoch: u64, side: u8, chips: u64, now: i64) -> R<u64> {
    if m.enabled == 0 { return Err(MarketError::Closed); }
    if side != UP && side != DOWN { return Err(MarketError::BadPick); }
    if epoch != m.open.epoch { return Err(MarketError::RoundMoved); }
    if now >= m.open.lock_ts { return Err(MarketError::RoundLocked); }
    if chips == 0 || !m.wagers.iter().any(|w| *w != 0 && u64::from(*w) == chips) { return Err(MarketError::BadWager); }
    if chips > u64::from(h.params.max_bet_chips) || chips > vault_free(h) / CHIP / 200 { return Err(MarketError::MaxBet); }
    if p.btc.iter().any(|s| s.state != 0 && s.epoch == epoch) { return Err(MarketError::AlreadyBet); }
    let free = p.btc.iter().position(|s| s.state == 0).ok_or(MarketError::SlotsFull)?;
    let wager = chips.checked_mul(CHIP).ok_or(MarketError::Overflow)?;
    if p.chips < wager { return Err(MarketError::NoChips); }
    let payout_bps = m.payout_bps as u16;
    let hold = hold_of(wager, payout_bps);
    if h.vault.checked_add(wager).ok_or(MarketError::Overflow)? < h.reserved.checked_add(hold).ok_or(MarketError::Overflow)? { return Err(MarketError::VaultLow); }
    p.chips -= wager;
    h.chips_outstanding -= wager;
    h.vault += wager;
    h.reserved += hold;
    p.bet_seq += 1;
    p.btc[free] = BtcSlot { epoch, wager, seq: p.bet_seq, payout_bps, blessing_bps: blessing_bps(p.faith_milli), side, state: 1, _pad: [0; 2] };
    if side == UP { m.open.up += wager } else { m.open.down += wager }
    m.open.bets += 1;
    Ok(p.bet_seq)
}

/// None while the round is still running.
pub fn outcome_at(m: &Market, epoch: u64) -> Option<u8> {
    if epoch == 0 || epoch >= m.open.epoch || epoch == m.live.epoch { return None; }
    let r = &m.rounds[(epoch % RING) as usize];
    if u64::from(r.epoch) == epoch { return Some(r.outcome); }
    // a week on, the result has been overwritten: the stake was lost
    if epoch + ARCHIVE_ROUNDS <= m.open.epoch { return Some(0); }
    let (i, s) = archive_at(epoch);
    Some(match m.archive[i] >> s & 3 { 1 => UP, 2 => DOWN, _ => VOID })
}

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub struct Claimed {
    pub seq: u64,
    pub epoch: u64,
    pub side: u8,
    /// 1 up, 2 down, 3 tie, 4 void, 0 expired
    pub outcome: u8,
    pub wager: u64,
    pub payout: u64,
    pub blessing: u64,
    pub luck_gain_milli: u32,
    pub lock_c: u32,
    pub close_c: u32,
}

/// Settles every slot whose round is over. Anyone may ask for it: it only ever pays the bettor.
pub fn claim(p: &mut Player, h: &mut House, m: &Market, now: i64) -> Vec<Claimed> {
    let mut out = Vec::new();
    for i in 0..p.btc.len() {
        let s = p.btc[i];
        if s.state == 0 { continue; }
        let Some(outcome) = outcome_at(m, s.epoch) else { continue };
        p.btc[i] = bytemuck::Zeroable::zeroed();
        let hold = hold_of(s.wager, s.payout_bps);
        h.reserved = h.reserved.saturating_sub(hold);
        let (won, back) = (outcome == s.side, outcome == TIE || outcome == VOID);
        let pay = if won { hold } else if back { s.wager } else { 0 }.min(h.vault);
        h.vault -= pay;
        let blessing = if won { take_blessing(h, pay, s.blessing_bps, now) } else { 0 };
        if !won && !back {
            let t = bps(s.wager, TREASURY_BPS).min(h.vault);
            h.vault -= t;
            h.treasury += t;
            let j = bps(s.wager, JACKPOT_BPS).min(h.vault);
            h.vault -= j;
            h.jackpot += j;
        }
        let payout = pay + blessing;
        p.chips += payout;
        h.chips_outstanding += payout;
        let luck = if back { 0 } else {
            p.wagered = p.wagered.saturating_add(s.wager);
            add_luck(p, luck_award(h, s.wager / CHIP, now))
        };
        let e = (s.epoch as u16).to_le_bytes();
        record(p, s.seq, s.wager, payout, now, luck, [s.side, outcome, e[0], e[1]], blessing, MARKET, 0);
        let r = m.rounds[(s.epoch % RING) as usize];
        let (lock_c, close_c) = if u64::from(r.epoch) == s.epoch { (r.lock_c, r.close_c) } else { (0, 0) };
        out.push(Claimed { seq: s.seq, epoch: s.epoch, side: s.side, outcome, wager: s.wager, payout, blessing, luck_gain_milli: luck, lock_c, close_c });
    }
    out
}

/// "round 90 UP lock 59027.25 close 59030.10 up 12 down 7 bets 4": what explorers show
pub fn line(r: &RoundRec) -> String {
    let name = match r.outcome { UP => "UP", DOWN => "DOWN", TIE => "TIE", VOID => "VOID", _ => "?" };
    format!("round {} {} lock {}.{:02} close {}.{:02} up {} down {} bets {} at {}", r.epoch, name, r.lock_c / 100, r.lock_c % 100, r.close_c / 100, r.close_c % 100, r.up_chips, r.down_chips, r.bets, r.closed_ts)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bets::{place, settle, tests::{balanced, rig}};
    use crate::games::COIN;

    fn market(now: i64) -> Box<Market> {
        let mut m: Box<Market> = Box::new(bytemuck::Zeroable::zeroed());
        m.round_s = 60;
        m.grace_s = 20;
        m.payout_bps = 19_000;
        m.wagers = [1, 2, 5, 10, 0, 0, 0, 0];
        start(&mut m, now);
        m
    }
    fn bet_now(p: &mut Player, h: &mut House, m: &mut Market, e: u64, side: u8, chips: u64) -> R<u64> { let t = m.open.open_ts; bet(p, h, m, e, side, chips, t) }
    fn go(m: &mut Market, cents: u32) -> Tick {
        let now = m.open.lock_ts + 1;
        tick(m, Some((cents, now)), true, now)
    }

    #[test]
    fn a_win_a_loss_a_tie() {
        for (side, close, pay, label) in [(UP, 101, 19, UP), (UP, 99, 0, DOWN), (UP, 100, 10, TIE), (DOWN, 99, 19, DOWN), (DOWN, 101, 0, UP)] {
            let (mut p, mut h) = rig(5_000, 30);
            let mut m = market(0);
            assert_eq!(bet(&mut p, &mut h, &mut m, 1, side, 10, 5), Ok(1));
            assert_eq!((p.chips, h.reserved, m.open.bets), (20 * CHIP, 19 * CHIP, 1));
            assert!(claim(&mut p, &mut h, &m, 6).is_empty(), "open");
            assert_eq!(go(&mut m, 100), Tick::Priced { closed: None, locked: 1, price_c: 100 });
            assert!(claim(&mut p, &mut h, &m, 70).is_empty(), "live");
            go(&mut m, close);
            let c = claim(&mut p, &mut h, &m, 130);
            assert_eq!((c.len(), c[0].payout, c[0].outcome, c[0].lock_c, c[0].close_c), (1, pay * CHIP, label, 100, close));
            assert_eq!((p.chips, h.reserved), ((20 + pay) * CHIP, 0));
            assert_eq!(p.luck_milli, if label == TIE { 0 } else { 800 });
            assert!(claim(&mut p, &mut h, &m, 131).is_empty(), "once");
            balanced(&h);
        }
    }

    #[test]
    fn one_chip_wins_one_point_nine() {
        let (mut p, mut h) = rig(5_000, 1);
        let mut m = market(0);
        bet(&mut p, &mut h, &mut m, 1, UP, 1, 0).unwrap();
        go(&mut m, 100);
        go(&mut m, 101);
        claim(&mut p, &mut h, &m, 200);
        assert_eq!(p.chips, 1_900_000);
        balanced(&h);
    }

    #[test]
    fn what_a_bet_refuses() {
        let (mut p, mut h) = rig(5_000, 30);
        let mut m = market(0);
        for (e, s, c, t, want) in [(2, UP, 1, 0, MarketError::RoundMoved), (1, 0, 1, 0, MarketError::BadPick), (1, 3, 1, 0, MarketError::BadPick), (1, UP, 3, 0, MarketError::BadWager), (1, UP, 0, 0, MarketError::BadWager), (1, UP, 1, 60, MarketError::RoundLocked)] {
            assert_eq!(bet(&mut p, &mut h, &mut m, e, s, c, t), Err(want));
        }
        bet(&mut p, &mut h, &mut m, 1, UP, 1, 59).unwrap();
        assert_eq!(bet(&mut p, &mut h, &mut m, 1, DOWN, 1, 59), Err(MarketError::AlreadyBet));
        let (mut q, _) = rig(0, 0);
        assert_eq!(bet(&mut q, &mut h, &mut m, 1, UP, 1, 0), Err(MarketError::NoChips));
        let (mut q, mut poor) = rig(100, 30);
        assert_eq!(bet(&mut q, &mut poor, &mut m, 1, UP, 1, 0), Err(MarketError::MaxBet));
        stop(&mut m, 59);
        assert_eq!(bet(&mut p, &mut h, &mut m, 2, UP, 1, 59), Err(MarketError::Closed));
        // eight rounds without claiming fill the slots; claiming frees them
        let (mut p, mut h) = rig(5_000, 30);
        let mut m = market(0);
        for e in 1..=8 { bet_now(&mut p, &mut h, &mut m, e, UP, 1).unwrap(); go(&mut m, 100); }
        assert_eq!(bet_now(&mut p, &mut h, &mut m, 9, UP, 1), Err(MarketError::SlotsFull));
        assert_eq!(claim(&mut p, &mut h, &m, 999).len(), 7);
        bet_now(&mut p, &mut h, &mut m, 9, UP, 1).unwrap();
        balanced(&h);
    }

    #[test]
    fn a_market_bet_and_a_coin_flip_do_not_block_each_other() {
        let (mut p, mut h) = rig(5_000, 30);
        let mut m = market(0);
        let s = place(&mut p, &mut h, COIN, 10, 0, [0; 32], 0).unwrap();
        assert_eq!(bet(&mut p, &mut h, &mut m, 1, UP, 10, 0), Ok(s + 1));
        assert!(settle(&mut p, &mut h, &[0; 32], s, 1).is_some());
        go(&mut m, 100);
        go(&mut m, 101);
        assert_eq!(claim(&mut p, &mut h, &m, 200)[0].payout, 19 * CHIP);
        assert_eq!(h.reserved, 0);
        balanced(&h);
    }

    #[test]
    fn who_may_price_a_round_and_with_what() {
        let mut m = market(0);
        assert_eq!(tick(&mut m, Some((100, 59)), true, 59), Tick::Idle);
        assert_eq!(tick(&mut m, Some((100, 60)), false, 60), Tick::NotAllowed);
        assert_eq!(tick(&mut m, None, true, 61), Tick::NoPrice);
        // published before betting closed: somebody could have known it
        assert_eq!(tick(&mut m, Some((100, 59)), true, 61), Tick::NoPrice);
        assert_eq!(tick(&mut m, Some((100, 61)), true, 67), Tick::NoPrice, "too old");
        assert_eq!(tick(&mut m, Some((100, 80)), true, 61), Tick::NoPrice, "from the future");
        assert_eq!(tick(&mut m, Some((0, 61)), true, 61), Tick::NoPrice);
        assert_eq!(m.open.epoch, 1);
        assert!(matches!(tick(&mut m, Some((100, 61)), true, 62), Tick::Priced { closed: None, locked: 1, .. }));
        assert_eq!((m.live.lock_c, m.live.locked_at, m.open.epoch, m.open.lock_ts), (100, 62, 2, 122));
    }

    #[test]
    fn a_late_round_is_void_for_everyone_and_anyone_may_say_so() {
        let (mut p, mut h) = rig(5_000, 30);
        let mut m = market(0);
        bet(&mut p, &mut h, &mut m, 1, UP, 10, 0).unwrap();
        go(&mut m, 100);
        bet_now(&mut p, &mut h, &mut m, 2, DOWN, 5).unwrap();
        let late = m.open.lock_ts + 21;
        let t = tick(&mut m, Some((500, late)), false, late);
        assert!(matches!(t, Tick::Voided { live: Some(_), .. }), "even with a fresh price, and even the crank: {t:?}");
        let c = claim(&mut p, &mut h, &m, late);
        assert_eq!(c.iter().map(|x| (x.outcome, x.payout)).collect::<Vec<_>>(), vec![(VOID, 10 * CHIP), (VOID, 5 * CHIP)]);
        assert_eq!((p.chips, h.reserved, m.live.epoch, m.open.epoch, m.voided), (30 * CHIP, 0, 0, 3, 2));
        balanced(&h);
        assert!(matches!(go(&mut m, 100), Tick::Priced { closed: None, locked: 3, .. }));
    }

    #[test]
    fn stopping_returns_every_bet_and_starting_again_moves_on() {
        let (mut p, mut h) = rig(5_000, 30);
        let mut m = market(0);
        bet(&mut p, &mut h, &mut m, 1, UP, 10, 0).unwrap();
        stop(&mut m, 30);
        assert!(stop(&mut m, 31).is_none());
        assert_eq!(tick(&mut m, Some((1, 99)), true, 99), Tick::Idle);
        assert_eq!(claim(&mut p, &mut h, &m, 99)[0].outcome, VOID);
        start(&mut m, 1_000);
        assert_eq!((m.open.epoch, m.open.lock_ts), (2, 1_060));
        assert_eq!(p.chips, 30 * CHIP);
        balanced(&h);
    }

    #[test]
    fn results_last_a_week_in_two_bits_and_four_hours_in_full() {
        let (mut p, mut h) = rig(50_000, 100);
        let mut m = market(0);
        let mut want = vec![0u8];
        let mut lock = 100u32;
        for e in 1..=11_000u64 {
            if e == 900 { bet_now(&mut p, &mut h, &mut m, e, UP, 10).unwrap(); }
            if e == 2_000 { bet_now(&mut p, &mut h, &mut m, e, UP, 10).unwrap(); }
            if e % 97 == 0 {
                let late = m.open.lock_ts + 30;
                let t = tick(&mut m, None, false, late);
                assert!(matches!(t, Tick::Voided { .. }));
                if let Tick::Voided { live: Some(r), .. } = t { want[r.epoch as usize] = VOID; }
                want.push(VOID);
                continue;
            }
            let c = [99u32, 100, 101][(e * 7 % 3) as usize];
            let Tick::Priced { closed, .. } = go(&mut m, c) else { panic!() };
            if let Some(r) = closed { want[r.epoch as usize] = if c > lock { UP } else if c < lock { DOWN } else { TIE }; }
            want.push(0);
            lock = c;
        }
        let open = m.open.epoch;
        for e in 1..open {
            let got = outcome_at(&m, e);
            if e == m.live.epoch { assert_eq!(got, None); continue; }
            if e + ARCHIVE_ROUNDS <= open { assert_eq!(got, Some(0)); continue; }
            let w = want[e as usize];
            if e + RING > open { assert_eq!(got, Some(w), "ring {e}"); assert_eq!(u64::from(m.rounds[(e % RING) as usize].epoch), e); }
            else { assert_eq!(got, Some(if w == TIE { VOID } else { w }), "archive {e}"); }
        }
        // one bet is older than a week, the other is not
        let c = claim(&mut p, &mut h, &m, 9_000_000);
        assert_eq!(c.iter().map(|x| (x.epoch, x.outcome)).collect::<Vec<_>>(), vec![(900, 0), (2_000, if want[2_000] == TIE { VOID } else { want[2_000] })]);
        assert_eq!(c[0].payout, 0);
        assert_eq!(h.reserved, 0);
        balanced(&h);
    }

    #[test]
    fn many_players_random_histories_balance() {
        for seed in 1..=60u64 {
            let mut x = seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1;
            let mut next = || { x ^= x << 13; x ^= x >> 7; x ^= x << 17; x };
            let (_, mut h) = rig(6_000, 0);
            let mut ps: Vec<Player> = (0..8).map(|_| { let mut p: Player = bytemuck::Zeroable::zeroed(); p.chips = 200 * CHIP; p.faith_milli = (next() % 100_001) as u32; p }).collect();
            h.chips_outstanding = 1_600 * CHIP;
            h.total_credited = h.vault + h.treasury + h.jackpot + h.chips_outstanding;
            let mut m = market(0);
            let mut now = 0;
            for _ in 0..600 {
                now += (next() % 9) as i64;
                let k = (next() % 8) as usize;
                match next() % 4 {
                    0 | 1 => { let e = m.open.epoch; let _ = bet(&mut ps[k], &mut h, &mut m, e, 1 + (next() % 2) as u8, [1, 2, 5, 10][(next() % 4) as usize], now); }
                    2 => { claim(&mut ps[k], &mut h, &m, now); }
                    _ => { let late = next() % 40 == 0; if late { now += 90; } tick(&mut m, Some((100 + (next() % 3) as u32, now)), next() % 5 != 0, now); }
                }
                assert!(h.reserved <= h.vault, "seed {seed}");
                balanced(&h);
                assert_eq!(ps.iter().map(|p| p.chips).sum::<u64>(), h.chips_outstanding);
                assert!(m.open.up + m.open.down <= 80 * CHIP);
            }
            stop(&mut m, now);
            for p in ps.iter_mut() { claim(p, &mut h, &m, now); assert!(p.btc.iter().all(|s| s.state == 0)); }
            assert_eq!(h.reserved, 0, "nothing left held");
            balanced(&h);
        }
    }

    #[test]
    fn the_feed_is_read_the_way_it_was_seen_live() {
        let mut d = vec![0u8; 134];
        d[73..81].copy_from_slice(&5_770_544_050_803i64.to_le_bytes());
        d[93..101].copy_from_slice(&1_795_619_954i64.to_le_bytes());
        assert_eq!(read_feed(&d), Some((5_770_544, 1_795_619_954)));
        assert_eq!(read_feed(&d[..100]), None);
        d[73..81].copy_from_slice(&(-1i64).to_le_bytes());
        assert_eq!(read_feed(&d), None);
        d[73..81].copy_from_slice(&i64::MAX.to_le_bytes());
        assert_eq!(read_feed(&d), None);
        assert_eq!(line(&RoundRec { epoch: 90, lock_c: 5_902_725, close_c: 5_903_010, closed_ts: 7, up_chips: 12, down_chips: 7, bets: 4, outcome: UP, late_s: 1 }), "round 90 UP lock 59027.25 close 59030.10 up 12 down 7 bets 4 at 7");
    }
}
