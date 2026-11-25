//! Blackjack. Pure: no accounts, no CPI.
//!
//! One deck, no hole card, dealer stands on every 17, naturals pay 3:2 (whole chips), double on two cards, no split.
//!
//! Every action asks the oracle for its own randomness, so nothing about a later card exists before it is asked for.
//! Cards of one answer come from sha256(randomness || k), k = 0, 1, 2...; dealt cards are a 52-bit mask, so every draw
//! is without replacement. The most a hand can pay is a doubled win, 4x the bet: that is held from the deal on.

use crate::bets::{add_luck, bps, luck_award, record, take_blessing, wager_allowed, BetError, JACKPOT_BPS, TREASURY_BPS};
use crate::constants::CHIP;
use crate::games::{blessing_bps, mul_shift, BLACKJACK};
use crate::state::{Hand, House, Player};

type R<T> = core::result::Result<T, BetError>;

/// `Hand.stage`
pub const OVER: u8 = 0;
/// cards asked for, none on the table yet
pub const DEALING: u8 = 1;
pub const PLAYER: u8 = 2;

/// `Hand.awaiting`: what the answer on its way is for
pub const DEAL: u8 = 1;
pub const HIT: u8 = 2;
pub const STAND: u8 = 3;
pub const DOUBLE: u8 = 4;

pub const LOSE: u8 = 0;
pub const PUSH: u8 = 1;
pub const WIN: u8 = 2;
pub const NATURAL: u8 = 3;

pub fn hand_total(cards: &[u8]) -> (u8, bool) {
    let (mut sum, mut aces) = (0u16, 0u16);
    for c in cards {
        match c % 13 {
            0 => { aces += 1; sum += 11; }
            r if r >= 9 => sum += 10,
            r => sum += u16::from(r) + 1,
        }
    }
    while sum > 21 && aces > 0 { sum -= 10; aces -= 1; }
    (sum.min(255) as u8, aces > 0)
}
fn ten_or_ace(c: u8) -> bool {
    c % 13 == 0 || c % 13 >= 9
}
/// Lamports back before blessing, and the label. `stake` is what is in play (2x when doubled).
pub fn table_payout(player: &[u8], dealer: &[u8], original: u64, stake: u64) -> (u64, u8) {
    let (pt, dt) = (hand_total(player).0, hand_total(dealer).0);
    let (pn, dn) = (player.len() == 2 && pt == 21, dealer.len() == 2 && dt == 21);
    if pn && dn { return (original, PUSH); }
    if pn { return (original / CHIP * 5 / 2 * CHIP, NATURAL); }
    // original bets only: a double is given back when the dealer turns over a natural
    if dn { return (stake - original, LOSE); }
    if pt > 21 { return (0, LOSE); }
    if dt > 21 || pt > dt { return (stake * 2, WIN); }
    if pt == dt { return (stake, PUSH); }
    (0, LOSE)
}

/// Draws cards for one answer.
pub struct Shoe<'a> {
    seed: &'a [u8; 32],
    k: u8,
}
impl<'a> Shoe<'a> {
    pub fn new(seed: &'a [u8; 32]) -> Self { Self { seed, k: 0 } }
    pub fn draw(&mut self, used: &mut u64) -> u8 {
        let h = solana_sha256_hasher::hashv(&[self.seed, &[self.k]]).to_bytes();
        self.k += 1;
        let left = 52 - used.count_ones();
        let mut j = mul_shift(u32::from_le_bytes([h[0], h[1], h[2], h[3]]), left);
        for c in 0..52u8 {
            if *used >> c & 1 == 1 { continue; }
            if j == 0 { *used |= 1 << c; return c; }
            j -= 1;
        }
        unreachable!("a hand never uses the whole deck")
    }
}
fn give(to: &mut [u8; 12], n: &mut u8, card: u8) {
    // 21 in one deck takes at most 11 cards, so a 12th always ends the hand
    if usize::from(*n) < to.len() { to[usize::from(*n)] = card; *n += 1; }
}

pub fn deal(p: &mut Player, h: &mut House, chips: u64, now: i64) -> R<u64> {
    if p.busy() { return Err(BetError::Busy); }
    wager_allowed(h, chips)?;
    let wager = chips.checked_mul(CHIP).ok_or(BetError::Overflow)?;
    if p.chips < wager { return Err(BetError::NoChips); }
    let hold = wager.checked_mul(4).ok_or(BetError::Overflow)?;
    if h.vault.checked_add(wager).ok_or(BetError::Overflow)? < h.reserved.checked_add(hold).ok_or(BetError::Overflow)? { return Err(BetError::VaultLow); }
    p.chips -= wager;
    h.chips_outstanding -= wager;
    h.vault += wager;
    h.reserved += hold;
    p.bet_seq += 1;
    p.hand = Hand { seq: p.bet_seq, stake: wager, original: wager, hold, last_ts: now, stage: DEALING, awaiting: DEAL, blessing_bps: blessing_bps(p.faith_milli), ..bytemuck::Zeroable::zeroed() };
    Ok(p.bet_seq)
}

/// Returns (seq, step). A step is the number of cards the player holds: it is different for every request of a hand, so
/// an answer can only ever be used for the request it was made for.
pub fn act(p: &mut Player, h: &mut House, action: u8, now: i64) -> R<(u64, u8)> {
    if p.hand.stage != PLAYER { return Err(BetError::NoHand); }
    if p.hand.awaiting != 0 { return Err(BetError::Busy); }
    match action {
        HIT | STAND => {}
        DOUBLE => {
            if p.hand.n_player != 2 || p.hand.doubled != 0 { return Err(BetError::CannotDouble); }
            let extra = p.hand.original;
            if p.chips < extra { return Err(BetError::NoChips); }
            p.chips -= extra;
            h.chips_outstanding -= extra;
            h.vault += extra;
            p.hand.stake += extra;
            p.hand.doubled = 1;
        }
        _ => return Err(BetError::BadPick),
    }
    p.hand.awaiting = action;
    p.hand.last_ts = now;
    Ok((p.hand.seq, p.hand.n_player))
}

/// The player walked away: after `bj_idle_s` anyone may stand for them.
pub fn stand_idle(p: &mut Player, h: &mut House, now: i64) -> R<(u64, u8)> {
    if p.hand.stage != PLAYER || p.hand.awaiting != 0 { return Err(BetError::NoHand); }
    if now < p.hand.last_ts + i64::from(h.params.bj_idle_s) { return Err(BetError::TooEarly); }
    act(p, h, STAND, now)
}

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub struct Finished {
    pub wager: u64,
    pub payout: u64,
    pub blessing: u64,
    pub luck_gain_milli: u32,
    pub outcome: [u8; 4],
}
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub struct Step {
    pub action: u8,
    pub done: Option<Finished>,
}

/// None when the answer is for nothing we are waiting for: then nothing changes.
pub fn answer(p: &mut Player, h: &mut House, randomness: &[u8; 32], seq: u64, step: u8, now: i64) -> Option<Step> {
    let mut x = p.hand;
    if x.stage == OVER || x.awaiting == 0 || x.seq != seq || x.n_player != step { return None; }
    let action = x.awaiting;
    x.awaiting = 0; // first: a repeat finds nothing
    x.last_ts = now;
    let mut shoe = Shoe::new(randomness);
    // what is left to do for this action: does the dealer play, or is it already over?
    let (over, dealer_plays) = match action {
        DEAL => {
            for i in 0..3 {
                let c = shoe.draw(&mut x.used);
                if i == 1 { give(&mut x.dealer, &mut x.n_dealer, c); } else { give(&mut x.player, &mut x.n_player, c); }
            }
            let natural = hand_total(&x.player[..2]).0 == 21;
            if natural && ten_or_ace(x.dealer[0]) {
                let c = shoe.draw(&mut x.used);
                give(&mut x.dealer, &mut x.n_dealer, c);
            }
            (natural, false)
        }
        STAND => (true, true),
        _ => {
            let c = shoe.draw(&mut x.used);
            give(&mut x.player, &mut x.n_player, c);
            let t = hand_total(&x.player[..usize::from(x.n_player)]).0;
            let ends = t >= 21 || action == DOUBLE;
            (ends, ends && t <= 21)
        }
    };
    if dealer_plays {
        while hand_total(&x.dealer[..usize::from(x.n_dealer)]).0 < 17 {
            let c = shoe.draw(&mut x.used);
            give(&mut x.dealer, &mut x.n_dealer, c);
        }
    }
    x.stage = if over { OVER } else { PLAYER };
    p.hand = x; // the cards stay readable until the next deal
    p.last_vrf = *randomness;
    p.last_vrf_seq = seq;
    Some(Step { action, done: over.then(|| finish(p, h, now)) })
}

fn finish(p: &mut Player, h: &mut House, now: i64) -> Finished {
    let x = p.hand;
    let (pl, dl) = (&x.player[..usize::from(x.n_player)], &x.dealer[..usize::from(x.n_dealer)]);
    h.reserved = h.reserved.saturating_sub(x.hold);
    let (t, j) = (bps(x.stake, TREASURY_BPS).min(h.vault), bps(x.stake, JACKPOT_BPS));
    h.vault -= t;
    h.treasury += t;
    let j = j.min(h.vault);
    h.vault -= j;
    h.jackpot += j;
    let (pay, label) = table_payout(pl, dl, x.original, x.stake);
    let pay = pay.min(h.vault);
    h.vault -= pay;
    let blessing = if label == WIN || label == NATURAL { take_blessing(h, pay, x.blessing_bps, now) } else { 0 };
    let payout = pay + blessing;
    p.chips += payout;
    h.chips_outstanding += payout;
    let luck = add_luck(p, luck_award(h, x.stake / CHIP, now));
    p.blackjack = p.blackjack.saturating_add(1);
    p.wagered = p.wagered.saturating_add(x.stake);
    let outcome = [hand_total(pl).0, hand_total(dl).0, label, x.doubled];
    record(p, x.seq, x.stake, payout, now, luck, outcome, blessing, BLACKJACK, 0);
    Finished { wager: x.stake, payout, blessing, luck_gain_milli: luck, outcome }
}

/// The oracle never answered. Everything in play comes back, the double too.
pub fn refund(p: &mut Player, h: &mut House, now: i64) -> R<(u64, u64)> {
    let x = p.hand;
    if x.stage == OVER || x.awaiting == 0 { return Err(BetError::NothingPending); }
    if now < x.last_ts + i64::from(h.params.bet_timeout_s) { return Err(BetError::TooEarly); }
    h.reserved = h.reserved.saturating_sub(x.hold);
    h.vault = h.vault.checked_sub(x.stake).ok_or(BetError::Overflow)?;
    h.chips_outstanding += x.stake;
    p.chips += x.stake;
    p.hand = bytemuck::Zeroable::zeroed();
    p.timeouts = p.timeouts.saturating_add(1);
    Ok((x.seq, x.stake))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bets::{place, tests::{balanced, rig}};
    use crate::constants::DAY_S;
    use crate::games::COIN;

    fn rng(seed: u64) -> impl FnMut() -> u64 {
        let mut x = seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1;
        move || { x ^= x << 13; x ^= x >> 7; x ^= x << 17; x }
    }
    fn bytes(next: &mut impl FnMut() -> u64) -> [u8; 32] {
        let mut b = [0u8; 32];
        for c in b.chunks_mut(8) { c.copy_from_slice(&next().to_le_bytes()); }
        b
    }
    /// randomness whose first cards, on this deck, satisfy `ok`
    fn find(used: u64, n: usize, ok: impl Fn(&[u8]) -> bool) -> [u8; 32] {
        let mut next = rng(7);
        for _ in 0..4_000_000 {
            let b = bytes(&mut next);
            let (mut u, mut s) = (used, Shoe::new(&b));
            let cards: Vec<u8> = (0..n).map(|_| s.draw(&mut u)).collect();
            if ok(&cards) { return b; }
        }
        panic!("not found")
    }
    fn dealt(cards: [u8; 3]) -> (Player, House, u64) {
        let (mut p, mut h) = rig(5_000, 100);
        let s = deal(&mut p, &mut h, 10, 0).unwrap();
        // ranks only: 0 = ace, 9..12 = ten
        let b = find(0, 3, |c| (0..3).all(|i| c[i] % 13 == cards[i]));
        answer(&mut p, &mut h, &b, s, 0, 1).unwrap();
        (p, h, s)
    }

    #[test]
    fn totals_and_the_pay_table() {
        assert_eq!(hand_total(&[0, 5]), (17, true));
        assert_eq!(hand_total(&[0, 0]), (12, true));
        assert_eq!(hand_total(&[9, 10, 4]), (25, false));
        let c = CHIP;
        assert_eq!(table_payout(&[9, 10], &[9, 8], 10 * c, 10 * c), (20 * c, WIN));
        assert_eq!(table_payout(&[9, 10, 4], &[9, 8], 10 * c, 10 * c), (0, LOSE));
        assert_eq!(table_payout(&[0, 9], &[9, 8], 25 * c, 25 * c), (62 * c, NATURAL));
        assert_eq!(table_payout(&[9, 10], &[0, 9], 10 * c, 20 * c), (10 * c, LOSE));
        assert_eq!(table_payout(&[0, 9], &[0, 9], 10 * c, 10 * c), (10 * c, PUSH));
        // three cards making 21 are not a natural
        assert_eq!(table_payout(&[6, 6, 6], &[0, 9], 10 * c, 10 * c), (0, LOSE));
    }

    /// made by scripts/vectors/blackjack.mjs, a separate implementation; the browser's check uses the same file
    #[test]
    fn shared_card_vectors() {
        let doc: serde_json::Value = serde_json::from_str(include_str!("../bj_vectors.json")).unwrap();
        let all = doc.as_array().unwrap();
        assert!(all.len() >= 500);
        for v in all {
            let hex = v["r"].as_str().unwrap();
            let mut r = [0u8; 32];
            for i in 0..32 { r[i] = u8::from_str_radix(&hex[2 * i..2 * i + 2], 16).unwrap(); }
            let mut used: u64 = v["used"].as_str().unwrap().parse().unwrap();
            let mut s = Shoe::new(&r);
            let got: Vec<u64> = v["cards"].as_array().unwrap().iter().map(|_| u64::from(s.draw(&mut used))).collect();
            assert_eq!(got, v["cards"].as_array().unwrap().iter().map(|c| c.as_u64().unwrap()).collect::<Vec<_>>());
        }
    }

    #[test]
    fn a_deal_is_one_deck_and_every_card_is_as_likely() {
        let mut next = rng(3);
        let mut seen = [0u32; 52];
        for _ in 0..20_000 {
            let b = bytes(&mut next);
            let (mut used, mut s) = (0u64, Shoe::new(&b));
            for i in 0..10 { let c = s.draw(&mut used); if i == 9 { seen[usize::from(c)] += 1; } }
            assert_eq!(used.count_ones(), 10, "no card twice");
        }
        let chi: f64 = seen.iter().map(|n| (f64::from(*n) - 20_000.0 / 52.0).powi(2) / (20_000.0 / 52.0)).sum();
        assert!(chi < 90.0, "51 degrees of freedom, chi {chi}");
    }

    #[test]
    fn naturals() {
        // ace and ten against a six: paid at once
        let (p, h, _) = dealt([0, 5, 12]);
        assert_eq!((p.hand.stage, p.hand.n_dealer, p.chips, h.reserved), (OVER, 1, 115 * CHIP, 0));
        balanced(&h);
        // against a ten: the dealer turns one card first
        let (mut p, mut h) = rig(5_000, 100);
        let s = deal(&mut p, &mut h, 10, 0).unwrap();
        let b = find(0, 4, |c| c[0] % 13 == 0 && c[1] % 13 == 12 && c[2] % 13 == 11 && c[3] % 13 == 0);
        let d = answer(&mut p, &mut h, &b, s, 0, 1).unwrap().done.unwrap();
        assert_eq!((d.outcome[2], d.payout, p.chips), (PUSH, 10 * CHIP, 100 * CHIP));
        balanced(&h);
    }

    #[test]
    fn hit_bust_stand_and_double() {
        let (mut p, mut h, s) = dealt([9, 5, 9]); // 20 v 6
        assert_eq!((p.hand.stage, p.hand.awaiting), (PLAYER, 0));
        assert_eq!(act(&mut p, &mut h, HIT, 2).unwrap(), (s, 2));
        assert_eq!(act(&mut p, &mut h, STAND, 2), Err(BetError::Busy));
        let b = find(p.hand.used, 1, |c| c[0] % 13 == 8);
        let d = answer(&mut p, &mut h, &b, s, 2, 3).unwrap().done.unwrap();
        assert_eq!((d.outcome, d.payout, p.hand.n_dealer), ([29, 6, LOSE, 0], 0, 1));
        assert_eq!((h.reserved, p.chips, p.blackjack), (0, 90 * CHIP, 1));
        balanced(&h);

        let (mut p, mut h, s) = dealt([4, 5, 5]); // 11 v 6
        act(&mut p, &mut h, DOUBLE, 2).unwrap();
        assert_eq!((p.chips, p.hand.stake, h.reserved), (80 * CHIP, 20 * CHIP, 40 * CHIP));
        let b = find(p.hand.used, 3, |c| c[0] % 13 == 9 && c[1] % 13 == 9 && c[2] % 13 == 8);
        let d = answer(&mut p, &mut h, &b, s, 2, 3).unwrap().done.unwrap();
        assert_eq!((d.outcome, d.payout, d.wager, p.wagered), ([21, 25, WIN, 1], 40 * CHIP, 20 * CHIP, 20 * CHIP));
        assert_eq!(p.chips, 120 * CHIP);
        balanced(&h);

        // doubled into a dealer natural: the extra stake comes back
        let (mut p, mut h, s) = dealt([4, 0, 5]);
        act(&mut p, &mut h, DOUBLE, 2).unwrap();
        let b = find(p.hand.used, 2, |c| c[0] % 13 == 3 && c[1] % 13 == 10);
        let d = answer(&mut p, &mut h, &b, s, 2, 3).unwrap().done.unwrap();
        assert_eq!((d.outcome[2], d.payout, p.chips), (LOSE, 10 * CHIP, 90 * CHIP));
        balanced(&h);

        // 21 stands by itself
        let (mut p, mut h, s) = dealt([4, 5, 5]);
        act(&mut p, &mut h, HIT, 2).unwrap();
        let b = find(p.hand.used, 1, |c| c[0] % 13 == 10);
        assert!(answer(&mut p, &mut h, &b, s, 2, 3).unwrap().done.is_some());
        assert!(p.hand.n_dealer >= 2);
    }

    #[test]
    fn what_a_hand_refuses() {
        let (mut p, mut h) = rig(5_000, 15);
        assert_eq!(act(&mut p, &mut h, HIT, 0), Err(BetError::NoHand));
        assert_eq!(stand_idle(&mut p, &mut h, 999), Err(BetError::NoHand));
        assert_eq!(deal(&mut p, &mut h, 11, 0), Err(BetError::BadWager));
        assert_eq!(deal(&mut p, &mut h, u64::MAX, 0), Err(BetError::BadWager));
        let s = deal(&mut p, &mut h, 10, 0).unwrap();
        assert_eq!(deal(&mut p, &mut h, 10, 0), Err(BetError::Busy));
        assert_eq!(place(&mut p, &mut h, COIN, 10, 0, [0; 32], 0), Err(BetError::Busy));
        assert_eq!(act(&mut p, &mut h, HIT, 0), Err(BetError::NoHand));
        answer(&mut p, &mut h, &find(0, 3, |c| c[0] % 13 == 4 && c[2] % 13 == 5), s, 0, 1).unwrap();
        assert_eq!(act(&mut p, &mut h, DOUBLE, 1), Err(BetError::NoChips));
        assert_eq!(act(&mut p, &mut h, 9, 1), Err(BetError::BadPick));
        assert_eq!(act(&mut p, &mut h, DEAL, 1), Err(BetError::BadPick));
        act(&mut p, &mut h, HIT, 1).unwrap();
        let b = find(p.hand.used, 1, |c| c[0] % 13 == 1);
        answer(&mut p, &mut h, &b, s, 2, 2).unwrap();
        p.chips += 100 * CHIP;
        assert_eq!(act(&mut p, &mut h, DOUBLE, 3), Err(BetError::CannotDouble));
    }

    #[test]
    fn late_repeated_and_foreign_answers_change_nothing() {
        let (mut p, mut h, s) = dealt([4, 5, 5]);
        let deal_again = [9; 32];
        let before = (p.hand.n_player, p.chips, h.vault);
        // nothing asked for; the deal's answer again; another hand's
        assert!(answer(&mut p, &mut h, &deal_again, s, 0, 2).is_none());
        assert!(answer(&mut p, &mut h, &deal_again, s, 2, 2).is_none());
        act(&mut p, &mut h, HIT, 2).unwrap();
        assert!(answer(&mut p, &mut h, &deal_again, s, 0, 2).is_none());
        assert!(answer(&mut p, &mut h, &deal_again, s + 1, 2, 2).is_none());
        assert_eq!((p.hand.n_player, p.chips, h.vault), before);
        let b = find(p.hand.used, 1, |c| c[0] % 13 == 1);
        assert!(answer(&mut p, &mut h, &b, s, 2, 3).is_some());
        assert!(answer(&mut p, &mut h, &deal_again, s, 2, 3).is_none());
    }

    #[test]
    fn idle_hands_stand_and_stuck_hands_are_refunded() {
        let (mut p, mut h, s) = dealt([9, 5, 9]);
        assert_eq!(refund(&mut p, &mut h, 9_999), Err(BetError::NothingPending)); // waiting for the player, not the oracle
        assert_eq!(stand_idle(&mut p, &mut h, 120), Err(BetError::TooEarly));
        assert_eq!(stand_idle(&mut p, &mut h, 121).unwrap(), (s, 2));
        assert!(answer(&mut p, &mut h, &[5; 32], s, 2, 122).unwrap().done.is_some());
        balanced(&h);

        let (mut p, mut h, s) = dealt([4, 5, 5]);
        act(&mut p, &mut h, DOUBLE, 10).unwrap();
        assert_eq!(stand_idle(&mut p, &mut h, 9_999), Err(BetError::NoHand));
        assert_eq!(refund(&mut p, &mut h, 189), Err(BetError::TooEarly));
        assert_eq!(refund(&mut p, &mut h, 190).unwrap(), (s, 20 * CHIP));
        assert_eq!((p.chips, h.reserved, p.busy()), (100 * CHIP, 0, false));
        assert!(answer(&mut p, &mut h, &[5; 32], s, 2, 191).is_none());
        balanced(&h);
    }

    #[test]
    fn random_hands_balance_and_the_vault_can_always_pay() {
        for seed in 1..=400u64 {
            let mut next = rng(seed);
            let (mut p, mut h) = rig(4_000, 400);
            let mut now = 10 * DAY_S;
            for _ in 0..40 {
                now += (next() % 60) as i64;
                p.faith_milli = (next() % 100_001) as u32;
                let before = p.chips;
                let Ok(s) = deal(&mut p, &mut h, 10, now) else { continue };
                let mut step = 0;
                loop {
                    assert!(h.reserved <= h.vault);
                    balanced(&h);
                    if next() % 25 == 0 { now += 200; let (_, back) = refund(&mut p, &mut h, now).unwrap(); assert_eq!(p.chips, before); assert!(back <= 20 * CHIP); break; }
                    let b = bytes(&mut next);
                    let r = answer(&mut p, &mut h, &b, s, step, now).unwrap();
                    if let Some(d) = r.done {
                        assert!(d.payout - d.blessing <= 4 * 10 * CHIP);
                        assert_eq!(p.chips, before - d.wager + d.payout);
                        break;
                    }
                    assert!(hand_total(&p.hand.player[..usize::from(p.hand.n_player)]).0 < 21);
                    let a = match next() % 4 { 0 => DOUBLE, 1 => STAND, _ => HIT };
                    let a = if act(&mut p, &mut h, a, now).is_ok() { a } else { act(&mut p, &mut h, HIT, now).unwrap(); HIT };
                    let _ = a;
                    step = p.hand.n_player;
                }
                assert!(!p.busy() && h.reserved == 0);
                assert_eq!(p.chips, h.chips_outstanding);
                assert_eq!(p.chips % CHIP, 0, "whole chips");
                balanced(&h);
            }
        }
    }

    /// The same fixed strategy as packages/sim/src/blackjack.ts plays on the shuffled deck of rules.ts.
    /// stand on 17+, or on 13+ against 2 to 6; double hard 10 and 11 against 2 to 9
    #[test]
    fn return_matches_the_simulation() {
        let mut next = rng(99);
        let (mut staked, mut back) = (0u64, 0u64);
        let n: u64 = std::env::var("HANDS").ok().and_then(|v| v.parse().ok()).unwrap_or(400_000);
        for _ in 0..n {
            let (mut p, mut h) = rig(1_000_000, 1_000);
            let s = deal(&mut p, &mut h, 10, 0).unwrap();
            let mut step = 0;
            loop {
                let b = bytes(&mut next);
                if let Some(d) = answer(&mut p, &mut h, &b, s, step, 0).unwrap().done { staked += d.wager; back += d.payout; break; }
                let (t, soft) = hand_total(&p.hand.player[..usize::from(p.hand.n_player)]);
                let up = p.hand.dealer[0] % 13; // 0 = ace, 1 = two
                let a = if p.hand.n_player == 2 && !soft && (t == 10 || t == 11) && (1..=8).contains(&up) { DOUBLE }
                    else if t >= 17 || (t >= 13 && (1..=5).contains(&up) && !soft) { STAND } else { HIT };
                act(&mut p, &mut h, a, 0).unwrap();
                step = p.hand.n_player;
            }
        }
        let per_hand = (back as f64 - staked as f64) / (n as f64 * 10.0 * CHIP as f64);
        println!("blackjack: {per_hand:.4} per bet over {n} hands, returned {:.4} of chips in play", back as f64 / staked as f64);
        assert!((-0.03..0.0).contains(&per_hand), "{per_hand}");
    }
}
