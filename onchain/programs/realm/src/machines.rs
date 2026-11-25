//! Founders' Row: three plots, each a slot machine owned by a player. Wins are paid from its bankroll, losses go into it.
//! Pure.
//!
//! The house keeps nothing at these machines, so they earn no LUCK, no blessing, and take no free chips: otherwise an
//! owner could play against their own bankroll and collect all three for nothing.

use crate::bets::{bps, record, JACKPOT_BPS, TREASURY_BPS};
use crate::church::{ChurchError, R};
use crate::constants::CHIP;
use crate::games::{draws_of, max_payout, resolve, SLOTS};
use crate::state::{House, Machine, PendingBet, Player, Plots};
use anchor_lang::prelude::Pubkey;

pub const MIN_BANKROLL: u64 = 100 * CHIP;
pub const KEEP: u64 = 100 * CHIP;
pub const GATE_WAGERED: u64 = 100 * CHIP;
pub const GATE_FAITH_MILLI: u64 = 5_000;
pub const SKINS: u8 = 4;

pub fn valid_name(name: &str) -> bool {
    (3..=16).contains(&name.len()) && name.trim() == name && name.bytes().all(|c| c.is_ascii_alphanumeric() || b" _'-".contains(&c))
}
fn at(plots: &Plots, plot: u8) -> R<usize> {
    let i = usize::from(plot).checked_sub(1).filter(|i| *i < plots.machines.len()).ok_or(ChurchError::BadArgs)?;
    Ok(i)
}
fn mine(plots: &Plots, plot: u8, who: &Pubkey) -> R<usize> {
    let i = at(plots, plot)?;
    if plots.machines[i].id == 0 || plots.machines[i].owner != *who { return Err(ChurchError::NotAllowed); }
    Ok(i)
}
fn take(p: &mut Player, h: &mut House, amount: u64) -> R<()> {
    if p.chips < amount { return Err(ChurchError::NoChips); }
    p.chips -= amount;
    h.chips_outstanding -= amount;
    Ok(())
}
fn give(p: &mut Player, h: &mut House, amount: u64) {
    p.chips += amount;
    h.chips_outstanding += amount;
}

pub fn claim_plot(p: &mut Player, h: &mut House, plots: &mut Plots, plot: u8, name: &str, skin: u8, bankroll_chips: u64) -> R<u32> {
    let i = at(plots, plot)?;
    if plots.machines[i].id != 0 { return Err(ChurchError::PlotTaken); }
    if !valid_name(name) { return Err(ChurchError::BadName); }
    if skin >= SKINS { return Err(ChurchError::BadArgs); }
    let bankroll = bankroll_chips.checked_mul(CHIP).ok_or(ChurchError::Overflow)?;
    if bankroll < MIN_BANKROLL { return Err(ChurchError::BadArgs); }
    let gate = p.flags & crate::constants::FLAG_PLOT_GATE != 0 || (p.wagered >= GATE_WAGERED && p.faith_earned_milli >= GATE_FAITH_MILLI);
    if !gate { return Err(ChurchError::PlotGate); }
    take(p, h, bankroll)?;
    h.machine_total += bankroll;
    plots.next_id += 1;
    let mut m = Machine { owner: p.authority, id: plots.next_id, skin, bankroll, ..bytemuck::Zeroable::zeroed() };
    m.name[..name.len()].copy_from_slice(name.as_bytes());
    plots.machines[i] = m;
    Ok(m.id)
}
pub fn fund(p: &mut Player, h: &mut House, plots: &mut Plots, plot: u8, chips: u64) -> R<()> {
    let i = mine(plots, plot, &p.authority)?;
    let amount = chips.checked_mul(CHIP).ok_or(ChurchError::Overflow)?;
    if amount == 0 { return Err(ChurchError::BadArgs); }
    take(p, h, amount)?;
    plots.machines[i].bankroll += amount;
    h.machine_total += amount;
    Ok(())
}
pub fn withdraw(p: &mut Player, h: &mut House, plots: &mut Plots, plot: u8, chips: u64) -> R<()> {
    let i = mine(plots, plot, &p.authority)?;
    let amount = chips.checked_mul(CHIP).ok_or(ChurchError::Overflow)?;
    let m = &mut plots.machines[i];
    if amount == 0 { return Err(ChurchError::BadArgs); }
    if m.bankroll.checked_sub(amount).is_none_or(|left| left < KEEP.max(m.reserved)) { return Err(ChurchError::Reserve); }
    m.bankroll -= amount;
    h.machine_total -= amount;
    give(p, h, amount);
    Ok(())
}
/// The deed is the owner field; whoever holds it has the bankroll.
pub fn transfer(p: &Player, plots: &mut Plots, plot: u8, to: Pubkey) -> R<()> {
    let i = mine(plots, plot, &p.authority)?;
    if to == Pubkey::default() { return Err(ChurchError::BadArgs); }
    plots.machines[i].owner = to;
    Ok(())
}
/// Takes the machine off the plot and returns its bankroll. `owner` must be the machine's owner.
pub fn release(owner: &mut Player, h: &mut House, plots: &mut Plots, plot: u8) -> R<u64> {
    let i = mine(plots, plot, &owner.authority)?;
    let m = plots.machines[i];
    if m.reserved != 0 { return Err(ChurchError::Reserve); }
    h.machine_total -= m.bankroll;
    give(owner, h, m.bankroll);
    plots.machines[i] = bytemuck::Zeroable::zeroed();
    Ok(m.bankroll)
}

pub fn place(p: &mut Player, h: &mut House, plots: &mut Plots, plot: u8, chips: u64, client_seed: [u8; 32], now: i64) -> R<u64> {
    if p.busy() { return Err(ChurchError::Busy); }
    let i = at(plots, plot)?;
    if plots.machines[i].id == 0 { return Err(ChurchError::BadArgs); }
    if chips == 0 || !h.params.allowed_wagers.iter().any(|w| *w != 0 && u64::from(*w) == chips) { return Err(ChurchError::BadWager); }
    if chips > u64::from(h.params.max_bet_chips) { return Err(ChurchError::MaxBet); }
    let wager = chips.checked_mul(CHIP).ok_or(ChurchError::Overflow)?;
    let max = max_payout(SLOTS, wager);
    let m = &plots.machines[i];
    if m.bankroll.checked_add(wager).ok_or(ChurchError::Overflow)? < m.reserved.checked_add(max).ok_or(ChurchError::Overflow)? { return Err(ChurchError::MaxBet); }
    take(p, h, wager)?;
    let m = &mut plots.machines[i];
    m.bankroll += wager;
    m.reserved += max;
    h.machine_total += wager;
    h.machine_reserved += max;
    p.bet_seq += 1;
    p.pending = PendingBet { seq: p.bet_seq, wager, hold: max, max_payout: max, placed_ts: now, client_seed, game: SLOTS, pick: 0, plot, active: 1, blessing_bps: 0, bonus_chips: 0 };
    Ok(p.bet_seq)
}

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub struct Spun {
    pub wager: u64,
    pub payout: u64,
    pub outcome: [u8; 4],
    pub machine: u32,
}
/// None when the answer is for nothing we are waiting for.
pub fn settle(p: &mut Player, h: &mut House, plots: &mut Plots, randomness: &[u8; 32], seq: u64, now: i64) -> Option<Spun> {
    let b = p.pending;
    if b.active == 0 || b.seq != seq || b.plot == 0 { return None; }
    let i = at(plots, b.plot).ok()?;
    p.pending = PendingBet { active: 0, ..bytemuck::Zeroable::zeroed() };
    let m = &mut plots.machines[i];
    m.reserved = m.reserved.saturating_sub(b.hold);
    h.machine_reserved = h.machine_reserved.saturating_sub(b.hold);
    let r = resolve(SLOTS, &draws_of(randomness), 0, b.wager);
    // the church and the jackpot take their share here too
    let t = bps(b.wager, TREASURY_BPS).min(m.bankroll);
    m.bankroll -= t;
    h.treasury += t;
    let j = bps(b.wager, JACKPOT_BPS).min(m.bankroll);
    m.bankroll -= j;
    h.jackpot += j;
    let pay = r.base.min(m.bankroll);
    m.bankroll -= pay;
    m.plays += 1;
    m.earned = m.earned.saturating_add((b.wager - t - j) as i64).saturating_sub(pay as i64);
    h.machine_total = h.machine_total.saturating_sub(t + j + pay);
    give(p, h, pay);
    p.spins = p.spins.saturating_add(1);
    p.wagered = p.wagered.saturating_add(b.wager);
    let c = &mut p.machine_plays[i];
    if c.machine_id != m.id { *c = crate::state::MachinePlays { machine_id: m.id, plays: 0 }; }
    c.plays = c.plays.saturating_add(1);
    p.last_vrf = *randomness;
    p.last_vrf_seq = seq;
    record(p, seq, b.wager, pay, now, 0, r.outcome, 0, SLOTS, 0);
    Some(Spun { wager: b.wager, payout: pay, outcome: r.outcome, machine: m.id })
}
pub fn refund(p: &mut Player, h: &mut House, plots: &mut Plots, now: i64) -> R<(u64, u64)> {
    let b = p.pending;
    if b.active == 0 || b.plot == 0 { return Err(ChurchError::NothingPending); }
    if now < b.placed_ts + i64::from(h.params.bet_timeout_s) { return Err(ChurchError::TooEarly); }
    let i = at(plots, b.plot)?;
    p.pending = PendingBet { active: 0, ..bytemuck::Zeroable::zeroed() };
    let m = &mut plots.machines[i];
    m.reserved = m.reserved.saturating_sub(b.hold);
    h.machine_reserved = h.machine_reserved.saturating_sub(b.hold);
    m.bankroll = m.bankroll.checked_sub(b.wager).ok_or(ChurchError::Overflow)?;
    h.machine_total = h.machine_total.checked_sub(b.wager).ok_or(ChurchError::Overflow)?;
    give(p, h, b.wager);
    p.timeouts = p.timeouts.saturating_add(1);
    Ok((b.seq, b.wager))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bets::tests::{balanced, rig};

    fn row() -> (Player, House, Plots) {
        let (mut p, h) = rig(5_000, 3_000);
        p.authority = Pubkey::new_from_array([1; 32]);
        (p.wagered, p.faith_earned_milli) = (100 * CHIP, 5_000);
        (p, h, bytemuck::Zeroable::zeroed())
    }
    #[test]
    fn claiming_a_plot() {
        let (mut p, mut h, mut l) = row();
        for (plot, name, skin, bank, e) in [(0, "Lucky", 0, 100, ChurchError::BadArgs), (4, "Lucky", 0, 100, ChurchError::BadArgs), (1, "ab", 0, 100, ChurchError::BadName), (1, "a<script>", 0, 100, ChurchError::BadName), (1, " Lucky", 0, 100, ChurchError::BadName), (1, "Lucky", 4, 100, ChurchError::BadArgs), (1, "Lucky", 0, 99, ChurchError::BadArgs), (1, "Lucky", 0, 3_001, ChurchError::NoChips)] {
            assert_eq!(claim_plot(&mut p, &mut h, &mut l, plot, name, skin, bank), Err(e), "{plot} {name} {skin} {bank}");
        }
        p.faith_earned_milli = 4_999;
        assert_eq!(claim_plot(&mut p, &mut h, &mut l, 1, "Lucky", 0, 100), Err(ChurchError::PlotGate));
        p.faith_earned_milli = 5_000;
        assert_eq!(claim_plot(&mut p, &mut h, &mut l, 1, "Lucky", 2, 1_000), Ok(1));
        assert_eq!((p.chips, h.machine_total, l.machines[0].bankroll), (2_000 * CHIP, 1_000 * CHIP, 1_000 * CHIP));
        assert_eq!(claim_plot(&mut p, &mut h, &mut l, 1, "Other", 0, 100), Err(ChurchError::PlotTaken));
        balanced(&h);
        let (mut q, _, _) = row();
        q.authority = Pubkey::new_from_array([2; 32]);
        assert_eq!(fund(&mut q, &mut h, &mut l, 1, 10), Err(ChurchError::NotAllowed));
        assert_eq!(withdraw(&mut q, &mut h, &mut l, 1, 10), Err(ChurchError::NotAllowed));
        assert_eq!(release(&mut q, &mut h, &mut l, 1), Err(ChurchError::NotAllowed));
        assert_eq!(transfer(&q, &mut l, 1, q.authority), Err(ChurchError::NotAllowed));
        assert_eq!(withdraw(&mut p, &mut h, &mut l, 1, 901), Err(ChurchError::Reserve));
        withdraw(&mut p, &mut h, &mut l, 1, 900).unwrap();
        fund(&mut p, &mut h, &mut l, 1, 50).unwrap();
        transfer(&p, &mut l, 1, q.authority).unwrap();
        assert_eq!(fund(&mut p, &mut h, &mut l, 1, 1), Err(ChurchError::NotAllowed));
        let before = q.chips;
        assert_eq!(release(&mut q, &mut h, &mut l, 1), Ok(150 * CHIP));
        assert_eq!((q.chips - before, h.machine_total, l.machines[0].id), (150 * CHIP, 0, 0));
        h.chips_outstanding -= 0;
        balanced(&h);
    }
    #[test]
    fn spins_are_paid_by_the_machine_and_earn_nothing_from_the_house() {
        let (mut p, mut h, mut l) = row();
        claim_plot(&mut p, &mut h, &mut l, 2, "Lucky", 0, 989).unwrap();
        assert_eq!(place(&mut p, &mut h, &mut l, 2, 10, [0; 32], 0), Err(ChurchError::MaxBet), "it must cover 100x");
        fund(&mut p, &mut h, &mut l, 2, 1).unwrap();
        crate::money::grant_bonus(&mut p, &mut h, 50 * CHIP).unwrap();
        p.faith_milli = 100_000;
        let (c, v) = (p.chips, h.vault);
        let s = place(&mut p, &mut h, &mut l, 2, 10, [0; 32], 0).unwrap();
        assert_eq!((p.chips, p.bonus), (c - 10 * CHIP, 50 * CHIP), "real chips only");
        assert_eq!(withdraw(&mut p, &mut h, &mut l, 2, 1), Err(ChurchError::Reserve), "held for the spin");
        assert_eq!(release(&mut p, &mut h, &mut l, 2), Err(ChurchError::Reserve));
        assert!(crate::bets::settle(&mut p, &mut h, &[0; 32], s, 1).is_none(), "the house cannot settle it");
        assert_eq!(crate::bets::refund(&mut p, &mut h, 9_999), Err(crate::bets::BetError::NothingPending));
        let r = settle(&mut p, &mut h, &mut l, &[0; 32], s, 1).unwrap(); // seven seven seven
        assert_eq!((r.payout, r.machine), (999_925_000, 1), "what the machine has after the shares");
        assert_eq!((h.vault, p.luck_milli, p.machine_plays[1].plays, l.machines[1].bankroll, l.machines[1].reserved, h.machine_reserved), (v, 0, 1, 0, 0, 0));
        assert!(settle(&mut p, &mut h, &mut l, &[0; 32], s, 1).is_none());
        balanced(&h);
        fund(&mut p, &mut h, &mut l, 2, 1_000).unwrap();
        let s = place(&mut p, &mut h, &mut l, 2, 10, [0; 32], 10).unwrap();
        assert_eq!(refund(&mut p, &mut h, &mut l, 189), Err(ChurchError::TooEarly));
        assert_eq!(refund(&mut p, &mut h, &mut l, 190), Ok((s, 10 * CHIP)));
        assert_eq!((l.machines[1].bankroll, l.machines[1].reserved), (1_000 * CHIP, 0));
        balanced(&h);
    }
    #[test]
    fn random_rows_balance() {
        for seed in 1..=200u64 {
            let mut x = seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1;
            let mut next = || { x ^= x << 13; x ^= x >> 7; x ^= x << 17; x };
            let (mut p, mut h, mut l) = row();
            let (mut q, _, _) = row();
            q.authority = Pubkey::new_from_array([2; 32]);
            h.chips_outstanding += q.chips;
            h.total_credited += q.chips;
            let mut now = 0;
            for _ in 0..150 {
                now += (next() % 60) as i64;
                let plot = 1 + (next() % 3) as u8;
                let who = if next() % 2 == 0 { &mut p } else { &mut q };
                match next() % 8 {
                    0 => { let _ = claim_plot(who, &mut h, &mut l, plot, "Lucky", 0, 100 + next() % 1_500); }
                    1 => { let _ = fund(who, &mut h, &mut l, plot, next() % 300); }
                    2 => { let _ = withdraw(who, &mut h, &mut l, plot, next() % 300); }
                    3 => { if next() % 6 == 0 { let _ = release(who, &mut h, &mut l, plot); } }
                    _ => if let Ok(s) = place(who, &mut h, &mut l, plot, 10, [0; 32], now) {
                        if next() % 10 == 0 { now += 200; refund(who, &mut h, &mut l, now).unwrap(); }
                        else { let mut r = [0u8; 32]; for c in r.chunks_mut(8) { c.copy_from_slice(&next().to_le_bytes()); } settle(who, &mut h, &mut l, &r, s, now).unwrap(); }
                    }
                }
                balanced(&h);
                assert_eq!(l.machines.iter().map(|m| m.bankroll).sum::<u64>(), h.machine_total);
                assert_eq!(p.chips + q.chips, h.chips_outstanding);
                assert!(h.machine_reserved == 0);
            }
        }
    }
}
