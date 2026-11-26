//! Don Fortuna and Father Nakamoto. Pure.
//!
//! A host's decision is anchored on L1 first (the `DecisionLog`, with the model's signature in the transaction), and only
//! then acted on here, once. Everything a host may do is bounded here, whatever the model asked for.
//!
//! A decision binds its action: hash = sha256(id || agent || response_sha256 || action bytes). The model's signed
//! response contains the action, so the chain only does what the signed answer said.

use crate::bets::bps;
use crate::church::{ChurchError, R};
use crate::constants::{CHIP, DAY_S};
use crate::money::grant_bonus;
use crate::state::{DecisionLog, House, Player, TimedEvent};

pub const FORTUNA: u8 = 0;
pub const NAKAMOTO: u8 = 1;
pub const HAPPY_HOUR: u8 = 0;
pub const VIGIL: u8 = 1;
pub const EVENT_GAP_S: i64 = 90 * 60;
pub const EVENTS_A_DAY: u32 = 4;
pub const PARAM_COOLDOWN_S: i64 = 5 * 60;
pub const CHURCH_COOLDOWN_S: i64 = 30 * 60;
/// a decision must be acted on within this
pub const DECISION_TTL_S: i64 = 30 * 60;
/// the LUCK rate may not go above this: `games::luck_never_costs_more_than_the_edge` is proven at it
pub const MAX_LUCK_RATE: u32 = 80;

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum Call {
    None,
    SetMaxBet(u32),
    SetLuckRate(u32),
    /// kind, minutes, boost (Vigils only: a Happy Hour doubles blessings)
    StartEvent(u8, u16, u32),
    EndEvent(u8),
    TopUpJackpot(u32),
    GrantAlms(u32),
    SetBlessingCap(u32),
    SetCandleFaith(u32),
}
impl Call {
    /// the bytes the decision hash covers
    pub fn bytes(&self) -> Vec<u8> {
        let (tag, a, b, c): (u8, u32, u32, u32) = match *self {
            Call::None => (0, 0, 0, 0),
            Call::SetMaxBet(v) => (1, v, 0, 0),
            Call::SetLuckRate(v) => (2, v, 0, 0),
            Call::StartEvent(k, m, boost) => (3, u32::from(k), u32::from(m), boost),
            Call::EndEvent(k) => (4, u32::from(k), 0, 0),
            Call::TopUpJackpot(v) => (5, v, 0, 0),
            Call::GrantAlms(v) => (6, v, 0, 0),
            Call::SetBlessingCap(v) => (7, v, 0, 0),
            Call::SetCandleFaith(v) => (8, v, 0, 0),
        };
        let mut out = vec![tag];
        for v in [a, b, c] { out.extend_from_slice(&v.to_le_bytes()); }
        out
    }
    fn whose(&self) -> Option<u8> {
        match self {
            Call::None => None,
            Call::SetMaxBet(_) | Call::SetLuckRate(_) | Call::TopUpJackpot(_) | Call::StartEvent(HAPPY_HOUR, ..) | Call::EndEvent(HAPPY_HOUR) => Some(FORTUNA),
            _ => Some(NAKAMOTO),
        }
    }
}
pub fn decision_hash(id: &[u8; 16], agent: u8, response_sha256: &[u8; 32], call: &Call) -> [u8; 32] {
    solana_sha256_hasher::hashv(&[id, &[agent], response_sha256, &call.bytes()]).to_bytes()
}

/// L1: remember a decision (the host's key signed this)
pub fn anchor(log: &mut DecisionLog, agent: u8, hash: [u8; 32], now: i64) {
    let i = (log.head % log.entries.len() as u64) as usize;
    log.entries[i] = crate::state::Anchored { hash, at: now, agent, _pad: [0; 7] };
    log.head += 1;
}
/// rollup: the decision was anchored by this host, recently, and never acted on
pub fn admit(h: &mut House, log: &DecisionLog, agent: u8, hash: [u8; 32], now: i64) -> R<()> {
    let e = log.entries.iter().find(|e| e.hash == hash).ok_or(ChurchError::NotAllowed)?;
    if e.agent != agent || now - e.at > DECISION_TTL_S { return Err(ChurchError::NotAllowed); }
    if h.used_decisions.iter().any(|u| *u == hash) { return Err(ChurchError::AlreadyClaimed); }
    let i = (h.used_head % h.used_decisions.len() as u64) as usize;
    h.used_decisions[i] = hash;
    h.used_head += 1;
    Ok(())
}

pub fn live(h: &House, kind: u8, now: i64) -> bool {
    let e = &h.events[usize::from(kind)];
    e.active != 0 && now < e.ends
}
fn step(old: u32, new: u32) -> bool {
    old > 0 && u64::from(old.abs_diff(new)) * 100 <= u64::from(old) * 25
}
fn day(h: &mut House, now: i64) {
    let d = now.div_euclid(DAY_S);
    if h.events_day != d { h.events_day = d; h.events_today = [0, 0]; }
    if h.alms_day != d { h.alms_day = d; h.alms_base = h.treasury; h.alms_spent = 0; }
    if h.topup_day != d { h.topup_day = d; h.topup_spent = 0; }
}

/// `who`: the player for alms. Returns free chips granted (alms) or 0.
pub fn act(h: &mut House, agent: u8, call: Call, who: Option<&mut Player>, now: i64) -> R<u64> {
    if call.whose().is_some_and(|a| a != agent) { return Err(ChurchError::NotAllowed); }
    day(h, now);
    let bad = Err(ChurchError::BadArgs);
    match call {
        Call::None => {}
        Call::SetMaxBet(v) => {
            let floor = h.params.allowed_wagers.iter().copied().max().unwrap_or(0).max(10);
            if !(floor..=500).contains(&v) || !step(h.params.max_bet_chips, v) || v == h.params.max_bet_chips { return bad; }
            if now < h.last_agent_change + PARAM_COOLDOWN_S { return Err(ChurchError::TooEarly); }
            h.params.max_bet_chips = v;
            h.last_agent_change = now;
        }
        Call::SetLuckRate(v) => {
            if !(20..=MAX_LUCK_RATE).contains(&v) || !step(h.params.luck_per_chip_milli, v) || v == h.params.luck_per_chip_milli { return bad; }
            if now < h.last_agent_change + PARAM_COOLDOWN_S { return Err(ChurchError::TooEarly); }
            h.params.luck_per_chip_milli = v;
            h.last_agent_change = now;
        }
        Call::StartEvent(kind, minutes, boost) => {
            if kind > VIGIL || !(10..=60).contains(&minutes) { return bad; }
            let boost = if kind == HAPPY_HOUR { 10_000 } else if (1_000..=5_000).contains(&boost) { boost } else { return bad };
            let k = usize::from(kind);
            if live(h, kind, now) || h.events_today[k] >= EVENTS_A_DAY { return Err(ChurchError::Closed); }
            if now < h.last_event_start[k] + EVENT_GAP_S { return Err(ChurchError::TooEarly); }
            h.events[k] = TimedEvent { started: now, ends: now + i64::from(minutes) * 60, boost_bps: boost, active: 1 };
            h.last_event_start[k] = now;
            h.events_today[k] += 1;
        }
        Call::EndEvent(kind) => {
            if kind > VIGIL || !live(h, kind, now) { return bad; }
            h.events[usize::from(kind)].active = 0;
        }
        Call::TopUpJackpot(chips) => {
            if !(1..=500).contains(&chips) || h.topup_spent + u64::from(chips) > 2_000 { return bad; }
            let amount = u64::from(chips) * CHIP;
            let free = h.vault.saturating_sub(h.reserved);
            if free < 3 * (h.reserved + amount) || h.vault < amount { return Err(ChurchError::TreasuryLow); }
            h.vault -= amount;
            h.jackpot += amount;
            h.topup_spent += u64::from(chips);
        }
        Call::GrantAlms(chips) => {
            let p = who.ok_or(ChurchError::BadArgs)?;
            if !(1..=50).contains(&chips) { return bad; }
            if p.chips + p.bonus >= 50 * CHIP || (p.wagered < 100 * CHIP && p.candles < 1) { return Err(ChurchError::NotAllowed); }
            if p.last_alms != 0 && now < p.last_alms + DAY_S { return Err(ChurchError::Cooldown); }
            let amount = u64::from(chips) * CHIP;
            // 2% of the day's opening treasury, never less than 100 chips
            if h.alms_spent + amount > bps(h.alms_base, 200).max(100 * CHIP) || h.treasury < amount { return Err(ChurchError::TreasuryLow); }
            h.treasury -= amount;
            h.alms_spent += amount;
            // free chips: what the treasury gave now stands behind them in the vault
            h.vault += amount;
            grant_bonus(p, h, amount).map_err(|_| ChurchError::Overflow)?;
            p.last_alms = now;
            return Ok(amount);
        }
        Call::SetBlessingCap(v) => {
            if !(100..=1_000).contains(&v) || !step(h.params.blessing_day_cap_bps, v) || v == h.params.blessing_day_cap_bps { return bad; }
            if now < h.last_priest_change + CHURCH_COOLDOWN_S { return Err(ChurchError::TooEarly); }
            h.params.blessing_day_cap_bps = v;
            h.last_priest_change = now;
        }
        Call::SetCandleFaith(v) => {
            if !(2_000..=4_000).contains(&v) || !step(h.params.candle_faith_milli, v) || v == h.params.candle_faith_milli { return bad; }
            if now < h.last_priest_change + CHURCH_COOLDOWN_S { return Err(ChurchError::TooEarly); }
            h.params.candle_faith_milli = v;
            h.last_priest_change = now;
        }
    }
    Ok(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bets::tests::{balanced, rig};

    #[test]
    fn a_decision_acts_once_by_its_own_host_while_fresh() {
        let (_, mut h) = rig(1_000, 0);
        let mut log: DecisionLog = bytemuck::Zeroable::zeroed();
        let (id, resp) = ([7; 16], [9; 32]);
        let call = Call::StartEvent(VIGIL, 20, 2_000);
        let hash = decision_hash(&id, NAKAMOTO, &resp, &call);
        assert_ne!(hash, decision_hash(&id, NAKAMOTO, &resp, &Call::StartEvent(VIGIL, 20, 2_001)), "the action is in the hash");
        assert_eq!(admit(&mut h, &log, NAKAMOTO, hash, 0), Err(ChurchError::NotAllowed), "never anchored");
        anchor(&mut log, NAKAMOTO, hash, 100);
        assert_eq!(admit(&mut h, &log, FORTUNA, hash, 101), Err(ChurchError::NotAllowed), "another host's");
        assert_eq!(admit(&mut h, &log, NAKAMOTO, hash, 100 + DECISION_TTL_S + 1), Err(ChurchError::NotAllowed), "stale");
        admit(&mut h, &log, NAKAMOTO, hash, 101).unwrap();
        assert_eq!(admit(&mut h, &log, NAKAMOTO, hash, 102), Err(ChurchError::AlreadyClaimed));
        for n in 0..70u8 { anchor(&mut log, FORTUNA, [n; 32], 200); }
        assert!(log.entries.iter().all(|e| e.hash != hash), "the log is a ring");
    }

    #[test]
    fn each_host_has_its_own_tools_and_every_bound_holds() {
        let (_, mut h) = rig(5_000, 0);
        let t = 10 * DAY_S;
        assert_eq!(act(&mut h, NAKAMOTO, Call::SetMaxBet(12), None, t), Err(ChurchError::NotAllowed));
        assert_eq!(act(&mut h, FORTUNA, Call::GrantAlms(10), None, t), Err(ChurchError::NotAllowed));
        assert_eq!(act(&mut h, FORTUNA, Call::StartEvent(VIGIL, 20, 2_000), None, t), Err(ChurchError::NotAllowed));
        assert_eq!(act(&mut h, NAKAMOTO, Call::StartEvent(HAPPY_HOUR, 20, 0), None, t), Err(ChurchError::NotAllowed));
        for v in [9, 13, 501] { assert_eq!(act(&mut h, FORTUNA, Call::SetMaxBet(v), None, t), Err(ChurchError::BadArgs), "{v}"); }
        act(&mut h, FORTUNA, Call::SetMaxBet(12), None, t).unwrap();
        assert_eq!(act(&mut h, FORTUNA, Call::SetLuckRate(70), None, t + 60), Err(ChurchError::TooEarly));
        assert_eq!(act(&mut h, FORTUNA, Call::SetLuckRate(81), None, t + 400), Err(ChurchError::BadArgs), "never above 80");
        act(&mut h, FORTUNA, Call::SetLuckRate(60), None, t + 400).unwrap();
        assert_eq!(act(&mut h, FORTUNA, Call::SetLuckRate(44), None, t + 800), Err(ChurchError::BadArgs), "a 25% step at most");
        assert_eq!(h.params.luck_per_chip_milli, 60);
        // events
        assert_eq!(act(&mut h, FORTUNA, Call::StartEvent(HAPPY_HOUR, 9, 0), None, t), Err(ChurchError::BadArgs));
        act(&mut h, FORTUNA, Call::StartEvent(HAPPY_HOUR, 20, 3_000), None, t).unwrap();
        assert_eq!(h.events[0].boost_bps, 10_000, "a Happy Hour doubles blessings, whatever was asked");
        assert!(live(&h, HAPPY_HOUR, t + 1_199) && !live(&h, HAPPY_HOUR, t + 1_200));
        assert_eq!(act(&mut h, FORTUNA, Call::StartEvent(HAPPY_HOUR, 20, 0), None, t + 10), Err(ChurchError::Closed), "one at a time");
        act(&mut h, FORTUNA, Call::EndEvent(HAPPY_HOUR), None, t + 20).unwrap();
        assert_eq!(act(&mut h, FORTUNA, Call::EndEvent(HAPPY_HOUR), None, t + 21), Err(ChurchError::BadArgs));
        assert_eq!(act(&mut h, FORTUNA, Call::StartEvent(HAPPY_HOUR, 20, 0), None, t + 60), Err(ChurchError::TooEarly), "90 minutes apart");
        assert_eq!(act(&mut h, NAKAMOTO, Call::StartEvent(VIGIL, 20, 5_001), None, t), Err(ChurchError::BadArgs));
        for i in 0..4 { act(&mut h, NAKAMOTO, Call::StartEvent(VIGIL, 10, 2_000), None, t + i * EVENT_GAP_S).unwrap(); }
        assert_eq!(act(&mut h, NAKAMOTO, Call::StartEvent(VIGIL, 10, 2_000), None, t + 4 * EVENT_GAP_S), Err(ChurchError::Closed), "four a day");
        // the church's dials
        assert_eq!(act(&mut h, NAKAMOTO, Call::SetBlessingCap(1_001), None, t), Err(ChurchError::BadArgs));
        act(&mut h, NAKAMOTO, Call::SetBlessingCap(600), None, t).unwrap();
        assert_eq!(act(&mut h, NAKAMOTO, Call::SetCandleFaith(3_500), None, t + 60), Err(ChurchError::TooEarly));
        act(&mut h, NAKAMOTO, Call::SetCandleFaith(3_500), None, t + CHURCH_COOLDOWN_S).unwrap();
        // the jackpot
        let v = h.vault;
        act(&mut h, FORTUNA, Call::TopUpJackpot(500), None, t).unwrap();
        assert_eq!(v - h.vault, 500 * CHIP);
        for _ in 0..3 { act(&mut h, FORTUNA, Call::TopUpJackpot(500), None, t).unwrap(); }
        assert_eq!(act(&mut h, FORTUNA, Call::TopUpJackpot(1), None, t), Err(ChurchError::BadArgs), "2,000 a day");
        balanced(&h);
    }

    #[test]
    fn alms_only_for_the_active_and_broke_once_a_day_within_budget() {
        let (mut p, mut h) = rig(1_000, 60);
        let t = 10 * DAY_S;
        assert_eq!(act(&mut h, NAKAMOTO, Call::GrantAlms(10), Some(&mut p), t), Err(ChurchError::NotAllowed), "has 60 chips");
        p.chips = 0;
        h.chips_outstanding = 0;
        h.total_credited -= 60 * CHIP;
        assert_eq!(act(&mut h, NAKAMOTO, Call::GrantAlms(10), Some(&mut p), t), Err(ChurchError::NotAllowed), "never played");
        p.candles = 1;
        assert_eq!(act(&mut h, NAKAMOTO, Call::GrantAlms(51), Some(&mut p), t), Err(ChurchError::BadArgs));
        let (tr, v) = (h.treasury, h.vault);
        assert_eq!(act(&mut h, NAKAMOTO, Call::GrantAlms(30), Some(&mut p), t), Ok(30 * CHIP));
        assert_eq!((p.chips, p.bonus, tr - h.treasury, h.vault - v), (0, 30 * CHIP, 30 * CHIP, 30 * CHIP));
        p.bonus = 0;
        h.bonus_outstanding = 0;
        assert_eq!(act(&mut h, NAKAMOTO, Call::GrantAlms(10), Some(&mut p), t + 100), Err(ChurchError::Cooldown));
        // the day's budget: 2% of 250 chips is 5, so the floor of 100 applies
        let mut others: Vec<Player> = (0..3).map(|_| { let mut q: Player = bytemuck::Zeroable::zeroed(); q.candles = 1; q }).collect();
        assert_eq!(act(&mut h, NAKAMOTO, Call::GrantAlms(50), Some(&mut others[0]), t), Ok(50 * CHIP));
        assert_eq!(act(&mut h, NAKAMOTO, Call::GrantAlms(30), Some(&mut others[1]), t), Err(ChurchError::TreasuryLow));
        assert_eq!(act(&mut h, NAKAMOTO, Call::GrantAlms(20), Some(&mut others[1]), t), Ok(20 * CHIP));
        assert_eq!(act(&mut h, NAKAMOTO, Call::GrantAlms(1), Some(&mut others[2]), t), Err(ChurchError::TreasuryLow));
        assert_eq!(act(&mut h, NAKAMOTO, Call::GrantAlms(10), Some(&mut others[2]), t + DAY_S), Ok(10 * CHIP), "a new day");
        assert_eq!(act(&mut h, NAKAMOTO, Call::GrantAlms(10), None, t), Err(ChurchError::BadArgs));
    }
}
