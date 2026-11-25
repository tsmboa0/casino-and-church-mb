//! Tithe, altar, candles and quests. Pure.

use crate::bets::{add_luck, bps};
use crate::constants::{CHIP, METER_MAX};
use crate::money::grant_bonus;
use crate::state::{House, Player};

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum ChurchError {
    BadArgs,
    NoChips,
    LuckLow,
    FaithLow,
    Cooldown,
    AlreadyClaimed,
    NotDone,
    NotAllowed,
    Closed,
    TreasuryLow,
    PlotTaken,
    PlotGate,
    Reserve,
    BoardFull,
    Busy,
    BadName,
    BadWager,
    MaxBet,
    NothingPending,
    TooEarly,
    Overflow,
}
pub type R<T> = core::result::Result<T, ChurchError>;

pub fn add_faith(p: &mut Player, gain: u32) -> u32 {
    let applied = gain.min(METER_MAX - p.faith_milli.min(METER_MAX));
    p.faith_milli += applied;
    p.faith_earned_milli = p.faith_earned_milli.saturating_add(u64::from(applied));
    applied
}
/// a Vigil makes prayers worth more
pub fn faith_award(h: &House, raw: u32, now: i64) -> u32 {
    let e = &h.events[1];
    if e.active != 0 && now < e.ends { (u64::from(raw) * (10_000 + u64::from(e.boost_bps)) / 10_000) as u32 } else { raw }
}

/// Real chips to the treasury. 10 chips are 1 FAITH at no FAITH, half that at 100.
pub fn tithe(p: &mut Player, h: &mut House, chips: u64, now: i64) -> R<u32> {
    if chips < 10 { return Err(ChurchError::BadArgs); }
    let amount = chips.checked_mul(CHIP).ok_or(ChurchError::Overflow)?;
    if p.chips < amount { return Err(ChurchError::NoChips); }
    p.chips -= amount;
    h.chips_outstanding -= amount;
    h.treasury += amount;
    let raw = (u128::from(chips) * 100 * (200_000 - u128::from(p.faith_milli.min(METER_MAX))) / 200_000).min(u128::from(METER_MAX)) as u32;
    let gain = add_faith(p, faith_award(h, raw, now));
    p.tithed = p.tithed.saturating_add(amount);
    Ok(gain)
}
/// LUCK for FAITH, at `offer_ratio_bps`.
pub fn offer_luck(p: &mut Player, h: &House, luck_milli: u32) -> R<u32> {
    if luck_milli < 1_000 || p.luck_milli < luck_milli { return Err(ChurchError::LuckLow); }
    p.luck_milli -= luck_milli;
    p.converted_milli = p.converted_milli.saturating_add(u64::from(luck_milli));
    Ok(add_faith(p, bps(u64::from(luck_milli), u64::from(h.params.offer_ratio_bps)) as u32))
}
pub fn light_candle(p: &mut Player, h: &House, now: i64) -> R<u32> {
    if now < p.candle_at + i64::from(h.params.candle_cooldown_s) { return Err(ChurchError::Cooldown); }
    p.candle_at = now;
    p.candles = p.candles.saturating_add(1);
    Ok(add_faith(p, faith_award(h, h.params.candle_faith_milli, now)))
}

/// What a quest gives: (free chips, FAITH milli, LUCK milli). Each once.
pub fn claim_quest(p: &mut Player, h: &mut House, bit: u8) -> R<(u64, u32, u32)> {
    let (ready, chips, faith, luck) = match bit {
        0 => (p.spins >= 3, 50, 0, 0),
        1 => (p.flips >= 1, 40, 0, 0),
        2 => (p.tithed >= 50 * CHIP, 0, 5_000, 0),
        3 => (p.candles >= 2, 0, 0, 4_000),
        4 => (p.converted_milli >= 20_000, 100, 0, 0),
        _ => return Err(ChurchError::BadArgs),
    };
    if p.quests_claimed & (1 << bit) != 0 { return Err(ChurchError::AlreadyClaimed); }
    if !ready { return Err(ChurchError::NotDone); }
    p.quests_claimed |= 1 << bit;
    grant_bonus(p, h, chips * CHIP).map_err(|_| ChurchError::Overflow)?;
    Ok((chips, add_faith(p, faith), add_luck(p, luck)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bets::tests::{balanced, rig};

    #[test]
    fn tithes_are_real_chips_and_worth_less_to_the_faithful() {
        let (mut p, mut h) = rig(1_000, 100);
        crate::money::grant_bonus(&mut p, &mut h, 500 * CHIP).unwrap();
        assert_eq!(tithe(&mut p, &mut h, 9, 0), Err(ChurchError::BadArgs));
        assert_eq!(tithe(&mut p, &mut h, 101, 0), Err(ChurchError::NoChips), "free chips cannot be tithed");
        assert_eq!(tithe(&mut p, &mut h, u64::MAX, 0), Err(ChurchError::Overflow));
        assert_eq!(tithe(&mut p, &mut h, 10, 0), Ok(1_000));
        p.faith_milli = METER_MAX;
        assert_eq!(tithe(&mut p, &mut h, 10, 0), Ok(0), "full");
        p.faith_milli = 50_000;
        assert_eq!(tithe(&mut p, &mut h, 10, 0), Ok(750));
        assert_eq!((h.treasury, p.tithed, p.faith_earned_milli), (280 * CHIP, 30 * CHIP, 1_750));
        h.events[1] = crate::state::TimedEvent { started: 0, ends: 100, boost_bps: 5_000, active: 1 };
        p.faith_milli = 0;
        assert_eq!(tithe(&mut p, &mut h, 10, 99), Ok(1_500), "a Vigil");
        p.faith_milli = 0;
        assert_eq!(tithe(&mut p, &mut h, 10, 100), Ok(1_000), "over");
        balanced(&h);
    }
    #[test]
    fn altar_and_candles() {
        let (mut p, h) = rig(0, 0);
        p.luck_milli = 21_000;
        assert_eq!(offer_luck(&mut p, &h, 999), Err(ChurchError::LuckLow));
        assert_eq!(offer_luck(&mut p, &h, 21_001), Err(ChurchError::LuckLow));
        assert_eq!(offer_luck(&mut p, &h, 20_000), Ok(16_000));
        assert_eq!((p.luck_milli, p.faith_milli, p.converted_milli), (1_000, 16_000, 20_000));
        assert_eq!(light_candle(&mut p, &h, 1_000), Ok(3_000));
        assert_eq!(light_candle(&mut p, &h, 1_014), Err(ChurchError::Cooldown));
        assert_eq!(light_candle(&mut p, &h, 1_015), Ok(3_000));
        p.faith_milli = 99_000;
        assert_eq!(light_candle(&mut p, &h, 1_030), Ok(1_000));
    }
    #[test]
    fn quests_once_each_and_the_chips_are_free_ones() {
        let (mut p, mut h) = rig(1_000, 0);
        for b in 0..5 { assert_eq!(claim_quest(&mut p, &mut h, b), Err(ChurchError::NotDone)); }
        assert_eq!(claim_quest(&mut p, &mut h, 5), Err(ChurchError::BadArgs));
        (p.spins, p.flips, p.tithed, p.candles, p.converted_milli) = (3, 1, 50 * CHIP, 2, 20_000);
        assert_eq!((0..5).map(|b| claim_quest(&mut p, &mut h, b).unwrap()).collect::<Vec<_>>(), vec![(50, 0, 0), (40, 0, 0), (0, 5_000, 0), (0, 0, 4_000), (100, 0, 0)]);
        for b in 0..5 { assert_eq!(claim_quest(&mut p, &mut h, b), Err(ChurchError::AlreadyClaimed)); }
        assert_eq!((p.chips, p.bonus, h.vault), (0, 190 * CHIP, 1_000 * CHIP));
        balanced(&h);
    }
}
