//! Pure money rules. No accounts, no clock, no CPI: everything that moves value is here and property-tested.
//!
//! The bridge (MAGICBLOCK_PLAN section 6): each side keeps totals that only go up and settles the difference.
//!   buying:   Purse.deposited (L1)      - Player.credited (rollup)  = chips still owed to the player
//!   cash-out: Player.withdrawn (rollup) - Purse.paid_out (L1)       = SOL still owed to the player

use crate::constants::{CHIP, DAY_S, HOUR_S, METER_MAX};
use crate::state::{Bank, House, HousePurse, Player, Purse};

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum MoneyError {
    Overflow,
    NoChips,
    BadAmount,
    Busy,
    VaultLow,
    AlreadyClaimed,
}
type R<T> = core::result::Result<T, MoneyError>;

fn add(a: u64, b: u64) -> R<u64> {
    a.checked_add(b).ok_or(MoneyError::Overflow)
}
fn sub(a: u64, b: u64) -> R<u64> {
    a.checked_sub(b).ok_or(MoneyError::Overflow)
}

/// Turns what the player deposited, and has not been credited for, into chips. Repeating it does nothing.
pub fn sync_deposit(p: &mut Player, h: &mut House, deposited: u64) -> R<u64> {
    let due = deposited.saturating_sub(p.credited); // an old copy of the purse can only be lower: credit less, later
    if due == 0 {
        return Ok(0);
    }
    p.credited = add(p.credited, due)?;
    p.chips = add(p.chips, due)?;
    h.chips_outstanding = add(h.chips_outstanding, due)?;
    h.total_credited = add(h.total_credited, due)?;
    Ok(due)
}

/// The same for the house's own money.
pub fn sync_house(h: &mut House, hp: &HousePurse) -> R<u64> {
    let v = hp.vault.saturating_sub(h.credited_vault);
    let t = hp.treasury.saturating_sub(h.credited_treasury);
    let j = hp.jackpot.saturating_sub(h.credited_jackpot);
    h.credited_vault = add(h.credited_vault, v)?;
    h.credited_treasury = add(h.credited_treasury, t)?;
    h.credited_jackpot = add(h.credited_jackpot, j)?;
    h.vault = add(h.vault, v)?;
    h.treasury = add(h.treasury, t)?;
    h.jackpot = add(h.jackpot, j)?;
    let all = add(add(v, t)?, j)?;
    h.total_credited = add(h.total_credited, all)?;
    Ok(all)
}

/// Takes chips off the player for good. The SOL follows on L1.
pub fn cash_out(p: &mut Player, h: &mut House, chips: u64) -> R<u64> {
    if p.busy() {
        return Err(MoneyError::Busy);
    }
    let amount = chips.checked_mul(CHIP).ok_or(MoneyError::Overflow)?;
    if amount == 0 {
        return Err(MoneyError::BadAmount);
    }
    if p.chips < amount {
        return Err(MoneyError::NoChips);
    }
    p.chips = sub(p.chips, amount)?;
    p.withdrawn = add(p.withdrawn, amount)?;
    book_withdrawals(p, h)?;
    Ok(amount)
}

/// How much to pay now. Takes no amount from the caller. Updates the totals BEFORE any lamports move.
pub fn payout(withdrawn: u64, purse: &mut Purse, bank: &mut Bank, now: i64, cap_player_day: u64, cap_hour: u64, available: u64) -> R<u64> {
    let due = withdrawn.saturating_sub(purse.paid_out);
    if due == 0 {
        return Ok(0);
    }
    let (day, hour) = (now.div_euclid(DAY_S), now.div_euclid(HOUR_S));
    if purse.day_id != day {
        purse.day_id = day;
        purse.paid_today = 0;
    }
    if bank.hour_id != hour {
        bank.hour_id = hour;
        bank.paid_this_hour = 0;
    }
    let pay = due
        .min(cap_player_day.saturating_sub(purse.paid_today))
        .min(cap_hour.saturating_sub(bank.paid_this_hour))
        .min(available);
    purse.paid_out = add(purse.paid_out, pay)?;
    purse.paid_today = add(purse.paid_today, pay)?;
    bank.paid_this_hour = add(bank.paid_this_hour, pay)?;
    bank.total_paid = add(bank.total_paid, pay)?;
    Ok(pay)
}

/// A cash-out made on L1 while the player was off the rollup: the House hears about it here.
pub fn book_withdrawals(p: &mut Player, h: &mut House) -> R<()> {
    let due = sub(p.withdrawn, p.withdrawn_booked)?;
    if due > 0 {
        p.withdrawn_booked = p.withdrawn;
        h.chips_outstanding = sub(h.chips_outstanding, due)?;
        h.total_withdrawn = add(h.total_withdrawn, due)?;
    }
    Ok(())
}

/// The L1 side of the same: the House is on the rollup and cannot be touched here.
pub fn cash_out_l1(p: &mut Player, chips: u64) -> R<u64> {
    if p.busy() {
        return Err(MoneyError::Busy);
    }
    let amount = chips.checked_mul(CHIP).ok_or(MoneyError::Overflow)?;
    if amount == 0 {
        return Err(MoneyError::BadAmount);
    }
    if p.chips < amount {
        return Err(MoneyError::NoChips);
    }
    p.chips = sub(p.chips, amount)?;
    p.withdrawn = add(p.withdrawn, amount)?;
    Ok(amount)
}

pub fn vault_free(h: &House) -> u64 {
    h.vault.saturating_sub(h.reserved)
}

/// Chips from the vault to a player (welcome, quests, promos).
pub fn grant_from_vault(p: &mut Player, h: &mut House, amount: u64) -> R<()> {
    if amount > vault_free(h) {
        return Err(MoneyError::VaultLow);
    }
    h.vault = sub(h.vault, amount)?;
    h.chips_outstanding = add(h.chips_outstanding, amount)?;
    p.chips = add(p.chips, amount)?;
    Ok(())
}

pub fn welcome(p: &mut Player, h: &mut House, flag: u8) -> R<u64> {
    if p.flags & flag != 0 {
        return Err(MoneyError::AlreadyClaimed);
    }
    let amount = u64::from(h.params.welcome_grant_chips) * CHIP;
    let cap = u64::from(h.params.welcome_cap_total_chips) * CHIP;
    let paid = add(h.welcome_paid, amount)?;
    if amount == 0 || paid > cap {
        return Err(MoneyError::VaultLow);
    }
    grant_from_vault(p, h, amount)?;
    h.welcome_paid = paid;
    p.flags |= flag;
    Ok(amount)
}

/// Everything the rollup owes. Invariant I1: equals total_credited - total_withdrawn.
pub fn liabilities(h: &House) -> u128 {
    [h.chips_outstanding, h.vault, h.treasury, h.jackpot, h.machine_total, h.escrow_total].iter().map(|v| u128::from(*v)).sum()
}

/// Lazy decay: only the meter of the realm you are NOT in fades. Plaza fades neither.
pub fn decay(p: &mut Player, now: i64, per_min_milli: u32, window_s: u32) {
    let dt = now.saturating_sub(p.last_update).clamp(0, i64::from(window_s)) as u64;
    let d = (dt * u64::from(per_min_milli) / 60).min(u64::from(METER_MAX)) as u32;
    match p.realm {
        1 => p.faith_milli = p.faith_milli.saturating_sub(d),
        2 => p.luck_milli = p.luck_milli.saturating_sub(d),
        _ => {}
    }
    p.last_update = now.max(p.last_update);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::constants::FLAG_WELCOME;
    use crate::state::Params;

    fn player() -> Player { bytemuck::Zeroable::zeroed() }
    fn house() -> House { let mut h: House = bytemuck::Zeroable::zeroed(); h.params = Params::launch(); h }
    fn purse() -> Purse { Purse { owner: Default::default(), deposited: 0, paid_out: 0, last_deposit_ts: 0, day_id: 0, paid_today: 0, bump: 0 } }
    fn bank() -> Bank { Bank { total_deposited: 0, total_paid: 0, hour_id: 0, paid_this_hour: 0, bump: 0 } }
    struct Rng(u64);
    impl Rng {
        fn next(&mut self) -> u64 { self.0 ^= self.0 << 13; self.0 ^= self.0 >> 7; self.0 ^= self.0 << 17; self.0 }
        fn below(&mut self, n: u64) -> u64 { self.next() % n }
    }

    #[test]
    fn the_worked_example_from_the_plan() {
        let (mut p, mut h, mut pu, mut b) = (player(), house(), purse(), bank());
        pu.deposited = 50 * CHIP;
        assert_eq!(sync_deposit(&mut p, &mut h, pu.deposited), Ok(50 * CHIP));
        assert_eq!(sync_deposit(&mut p, &mut h, pu.deposited), Ok(0));
        pu.deposited += 20 * CHIP;
        assert_eq!(sync_deposit(&mut p, &mut h, pu.deposited), Ok(20 * CHIP));
        assert_eq!(p.chips, 70 * CHIP);
        assert_eq!(cash_out(&mut p, &mut h, 30), Ok(30 * CHIP));
        assert_eq!(payout(p.withdrawn, &mut pu, &mut b, 0, u64::MAX, u64::MAX, u64::MAX), Ok(30 * CHIP));
        assert_eq!(payout(p.withdrawn, &mut pu, &mut b, 0, u64::MAX, u64::MAX, u64::MAX), Ok(0));
        assert_eq!(p.chips, 40 * CHIP);
    }

    #[test]
    fn an_old_copy_of_the_purse_never_over_credits() {
        let (mut p, mut h) = (player(), house());
        assert_eq!(sync_deposit(&mut p, &mut h, 70 * CHIP), Ok(70 * CHIP));
        assert_eq!(sync_deposit(&mut p, &mut h, 50 * CHIP), Ok(0)); // stale
        assert_eq!(sync_deposit(&mut p, &mut h, 90 * CHIP), Ok(20 * CHIP));
        assert_eq!(p.chips, 90 * CHIP);
    }

    #[test]
    fn payout_caps_hold_and_the_rest_is_paid_later() {
        let (mut pu, mut b) = (purse(), bank());
        let w = 12 * 1_000 * CHIP;
        let cap = 5_000 * CHIP;
        assert_eq!(payout(w, &mut pu, &mut b, 10, cap, u64::MAX, u64::MAX), Ok(cap));
        assert_eq!(payout(w, &mut pu, &mut b, 20, cap, u64::MAX, u64::MAX), Ok(0));
        assert_eq!(payout(w, &mut pu, &mut b, DAY_S + 1, cap, u64::MAX, u64::MAX), Ok(cap));
        assert_eq!(payout(w, &mut pu, &mut b, 2 * DAY_S + 1, cap, u64::MAX, u64::MAX), Ok(2_000 * CHIP));
        assert_eq!(pu.paid_out, w);
        // the hourly cap is shared by everyone
        let (mut a, mut c, mut b2) = (purse(), purse(), bank());
        assert_eq!(payout(8 * CHIP, &mut a, &mut b2, 0, u64::MAX, 10 * CHIP, u64::MAX), Ok(8 * CHIP));
        assert_eq!(payout(8 * CHIP, &mut c, &mut b2, 1, u64::MAX, 10 * CHIP, u64::MAX), Ok(2 * CHIP));
        assert_eq!(payout(8 * CHIP, &mut c, &mut b2, HOUR_S, u64::MAX, 10 * CHIP, u64::MAX), Ok(6 * CHIP));
        // never more than the bank has
        let (mut d, mut b3) = (purse(), bank());
        assert_eq!(payout(8 * CHIP, &mut d, &mut b3, 0, u64::MAX, u64::MAX, 3 * CHIP), Ok(3 * CHIP));
    }

    #[test]
    fn welcome_once_and_within_the_cap() {
        let (mut p, mut h) = (player(), house());
        assert_eq!(welcome(&mut p, &mut h, FLAG_WELCOME), Err(MoneyError::VaultLow));
        h.vault = 1_000 * CHIP;
        assert_eq!(welcome(&mut p, &mut h, FLAG_WELCOME), Ok(30 * CHIP));
        assert_eq!(welcome(&mut p, &mut h, FLAG_WELCOME), Err(MoneyError::AlreadyClaimed));
        h.params.welcome_cap_total_chips = 59;
        assert_eq!(welcome(&mut player(), &mut h, FLAG_WELCOME), Err(MoneyError::VaultLow));
        h.reserved = h.vault; // everything is held for open bets
        h.params.welcome_cap_total_chips = 25_000;
        assert_eq!(welcome(&mut player(), &mut h, FLAG_WELCOME), Err(MoneyError::VaultLow));
    }

    #[test]
    fn cash_out_refuses_nothing_too_much_and_while_a_bet_is_open() {
        let (mut p, mut h) = (player(), house());
        sync_deposit(&mut p, &mut h, 10 * CHIP).unwrap();
        assert_eq!(cash_out(&mut p, &mut h, 0), Err(MoneyError::BadAmount));
        assert_eq!(cash_out(&mut p, &mut h, 11), Err(MoneyError::NoChips));
        assert_eq!(cash_out(&mut p, &mut h, u64::MAX), Err(MoneyError::Overflow));
        p.pending.active = 1;
        assert_eq!(cash_out(&mut p, &mut h, 1), Err(MoneyError::Busy));
        p.pending.active = 0;
        p.hand.stage = 1;
        assert_eq!(cash_out(&mut p, &mut h, 1), Err(MoneyError::Busy));
        p.hand.stage = 0;
        assert_eq!(cash_out(&mut p, &mut h, 10), Ok(10 * CHIP));
    }

    #[test]
    fn decay_only_touches_the_other_realm() {
        let mut p = player();
        p.luck_milli = 50_000; p.faith_milli = 50_000;
        p.realm = 1; decay(&mut p, 60, 500, 900); assert_eq!((p.luck_milli, p.faith_milli), (50_000, 49_500));
        p.realm = 2; decay(&mut p, 120, 500, 900); assert_eq!((p.luck_milli, p.faith_milli), (49_500, 49_500));
        p.realm = 0; decay(&mut p, 10_000, 500, 900); assert_eq!((p.luck_milli, p.faith_milli), (49_500, 49_500));
        p.realm = 1; decay(&mut p, 1_000_000, 500, 900); assert_eq!(p.faith_milli, 42_000); // 900 s at most
        decay(&mut p, 5, 500, 900); assert_eq!(p.last_update, 1_000_000); // a clock that goes back changes nothing
    }

    /// Random buys, stale syncs, replays, games, cash-outs, payouts, replays, and rollup fallbacks, over many players.
    #[test]
    fn random_histories_never_create_or_lose_money() {
        for seed in 1..=400u64 {
            let mut r = Rng(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1);
            let mut h = house(); let mut b = bank(); let mut hp = HousePurse { vault: 0, treasury: 0, jackpot: 0, bump: 0 };
            let mut sol: u64 = 0; // what the Bank really holds
            let (mut ps, mut pus) = (vec![player(); 4], vec![purse(), purse(), purse(), purse()]);
            let mut committed: Vec<u64> = vec![0; 4]; let mut now = 1_000_000i64;
            let (mut snap_p, mut snap_h) = (ps.clone(), h); let mut snap_ok = true;
            let mut wallet_out = [0u64; 4]; let mut wallet_in = [0u64; 4];
            for _ in 0..300 {
                let i = r.below(4) as usize; now += r.below(400) as i64;
                match r.below(13) {
                    0 | 1 => { let a = (1 + r.below(40)) * CHIP; pus[i].deposited += a; b.total_deposited += a; sol += a; wallet_in[i] += a; }
                    2 => { let seen = r.below(pus[i].deposited / CHIP + 1) * CHIP; let _ = sync_deposit(&mut ps[i], &mut h, seen); } // any older copy
                    3 | 4 => { let d = pus[i].deposited; sync_deposit(&mut ps[i], &mut h, d).unwrap(); assert_eq!(sync_deposit(&mut ps[i], &mut h, d), Ok(0)); }
                    5 => { let a = r.below(200) * CHIP; match r.below(3) { 0 => hp.vault += a, 1 => hp.treasury += a, _ => hp.jackpot += a } sol += a; b.total_deposited += a; sync_house(&mut h, &hp).unwrap(); assert_eq!(sync_house(&mut h, &hp), Ok(0)); }
                    6 => { let _ = welcome(&mut ps[i], &mut h, FLAG_WELCOME); }
                    7 => { // a game: chips move between the player and the vault
                        let a = r.below(ps[i].chips / CHIP + 1) * CHIP; ps[i].chips -= a; h.chips_outstanding -= a; h.vault += a;
                        if r.below(2) == 0 { let w = (a * 2).min(vault_free(&h)); h.vault -= w; ps[i].chips += w; h.chips_outstanding += w; } }
                    8 | 9 => { let c = r.below(ps[i].chips / CHIP + 2); if cash_out(&mut ps[i], &mut h, c).is_ok() { committed[i] = ps[i].withdrawn; snap_p = ps.clone(); snap_h = h; snap_ok = true; } } // the commit is part of cash-out
                    10 => { for _ in 0..1 + r.below(3) { let paid = payout(committed[i], &mut pus[i], &mut b, now, 500 * CHIP, 900 * CHIP, sol).unwrap(); sol -= paid; wallet_out[i] += paid; } }
                    11 => { let c = r.below(ps[i].chips / CHIP + 2); if cash_out_l1(&mut ps[i], c).is_ok() { book_withdrawals(&mut ps[i], &mut h).unwrap(); assert_eq!(ps[i].withdrawn, ps[i].withdrawn_booked); committed[i] = ps[i].withdrawn; snap_p = ps.clone(); snap_h = h; } }
                    _ => { if snap_ok && r.below(6) == 0 { ps = snap_p.clone(); h = snap_h; for k in 0..4 { let d = pus[k].deposited; sync_deposit(&mut ps[k], &mut h, d).unwrap(); } sync_house(&mut h, &hp).unwrap(); } } // the rollup falls back to its last commit
                }
                if ps.iter().any(|p| p.withdrawn != p.withdrawn_booked) { for p in ps.iter_mut() { book_withdrawals(p, &mut h).unwrap(); } } // what touch() does next
                // I1: the rollup's books balance
                assert_eq!(liabilities(&h), u128::from(h.total_credited) - u128::from(h.total_withdrawn), "seed {seed}");
                assert_eq!(ps.iter().map(|p| p.chips).sum::<u64>(), h.chips_outstanding, "seed {seed}");
                // I2 and I3: L1 holds what it took in minus what it paid, and never pays or credits ahead
                assert_eq!(sol, b.total_deposited - b.total_paid, "seed {seed}");
                assert!(h.total_credited <= b.total_deposited && b.total_paid <= committed.iter().sum::<u64>(), "seed {seed}");
                for k in 0..4 { assert!(ps[k].credited <= pus[k].deposited && pus[k].paid_out <= committed[k] && wallet_out[k] == pus[k].paid_out && wallet_in[k] == pus[k].deposited); }
                // the bank can always cover what players were promised
                assert!(u128::from(sol) >= liabilities(&h), "seed {seed}: bank {sol} owes {}", liabilities(&h));
            }
        }
    }
}
