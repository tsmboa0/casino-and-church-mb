//! Church campaigns. Pure.
//!
//! A player pays for the rewards up front (escrow) and 10% to the treasury; the Church oracle co-signs the transaction
//! that opens one (it read the wording and the link), and the claims of the kinds that happen off chain. Rewards a player
//! paid for are real chips. The Church's own campaigns, paid by the treasury, give free chips.

use crate::bets::bps;
use crate::church::{add_faith, ChurchError, R};
use crate::constants::{CHIP, DAY_S};
use crate::money::grant_bonus;
use crate::state::{Board, Campaign, House, Player, BOARD_IDS, BOARD_SLOTS};
use anchor_lang::prelude::Pubkey;

pub const SOCIAL: u8 = 0;
pub const PROJECT: u8 = 1;
pub const MACHINE: u8 = 2;
pub const MAX_REWARD_CHIPS: u32 = 50;
pub const MAX_REWARD_FAITH: u32 = 5_000;
pub const MAX_CLAIMS: u32 = 500;
pub const MIN_LISTING: u64 = 10 * CHIP;
pub const CREATOR_FAITH: u32 = 10_000;
pub const DAILY_FAITH: u32 = 10_000;

pub struct New<'a> {
    pub kind: u8,
    pub title: &'a str,
    pub url: &'a str,
    pub machine_id: u32,
    pub goal: u32,
    pub reward_chips: u32,
    pub reward_faith_milli: u32,
    pub max_claims: u32,
}
pub fn check(c: &New) -> R<()> {
    let t = c.title;
    let ok = c.kind <= MACHINE
        && (3..=60).contains(&t.len()) && t.trim() == t && t.bytes().all(|b| (0x20..0x7f).contains(&b))
        && c.url.len() <= 160 && (c.url.is_empty() || c.url.starts_with("https://")) && c.url.bytes().all(|b| (0x21..0x7f).contains(&b))
        && c.reward_chips <= MAX_REWARD_CHIPS && c.reward_faith_milli <= MAX_REWARD_FAITH && (c.reward_chips > 0 || c.reward_faith_milli > 0)
        && (1..=MAX_CLAIMS).contains(&c.max_claims)
        && if c.kind == MACHINE { c.machine_id > 0 && (1..=50).contains(&c.goal) && c.url.is_empty() } else { c.machine_id == 0 && c.goal == 0 && !c.url.is_empty() };
    if ok { Ok(()) } else { Err(ChurchError::BadArgs) }
}
/// (escrow, listing tithe)
pub fn cost(reward_chips: u32, max_claims: u32) -> (u64, u64) {
    let budget = u64::from(reward_chips) * u64::from(max_claims) * CHIP;
    (budget, bps(budget, 1_000).max(MIN_LISTING))
}
fn list(b: &mut Board, creator: Pubkey, c: &New, budget: u64, from_treasury: bool, now: i64) -> R<u32> {
    if b.next >= BOARD_IDS { return Err(ChurchError::BoardFull); }
    // a closed campaign whose refund is collected makes room; the oldest first
    let i = (0..BOARD_SLOTS).filter(|i| { let s = &b.slots[*i]; s.active == 0 && s.budget == 0 }).min_by_key(|i| b.slots[*i].created).ok_or(ChurchError::BoardFull)?;
    let id = u32::from(b.index) * BOARD_IDS + b.next;
    b.next += 1;
    let mut s = Campaign {
        creator, budget, created: now, id, machine_id: c.machine_id, goal: c.goal, reward_chips: c.reward_chips, reward_faith_milli: c.reward_faith_milli,
        max_claims: c.max_claims, claims: 0, kind: c.kind, active: 1, from_treasury: u8::from(from_treasury), title_len: c.title.len() as u8, url_len: c.url.len() as u8, ..bytemuck::Zeroable::zeroed()
    };
    s.title[..c.title.len()].copy_from_slice(c.title.as_bytes());
    s.url[..c.url.len()].copy_from_slice(c.url.as_bytes());
    b.slots[i] = s;
    Ok(id)
}
pub fn create(p: &mut Player, h: &mut House, b: &mut Board, c: &New, owns_machine: bool, now: i64) -> R<u32> {
    check(c)?;
    if c.kind == MACHINE && !owns_machine { return Err(ChurchError::NotAllowed); }
    if p.faith_milli < CREATOR_FAITH { return Err(ChurchError::FaithLow); }
    let (budget, listing) = cost(c.reward_chips, c.max_claims);
    if p.chips < budget + listing { return Err(ChurchError::NoChips); }
    let id = list(b, p.authority, c, budget, false, now)?;
    p.chips -= budget + listing;
    h.chips_outstanding -= budget + listing;
    h.escrow_total += budget;
    h.treasury += listing;
    Ok(id)
}
pub fn seed(admin: Pubkey, h: &mut House, b: &mut Board, c: &New, now: i64) -> R<u32> {
    check(c)?;
    if c.kind == MACHINE { return Err(ChurchError::BadArgs); }
    let (budget, _) = cost(c.reward_chips, c.max_claims);
    if h.treasury < budget { return Err(ChurchError::TreasuryLow); }
    let id = list(b, admin, c, budget, true, now)?;
    h.treasury -= budget;
    h.escrow_total += budget;
    Ok(id)
}
pub fn find(b: &Board, id: u32) -> R<usize> {
    b.slots.iter().position(|s| s.id == id && s.creator != Pubkey::default()).ok_or(ChurchError::BadArgs)
}
fn claimed(p: &Player, id: u32) -> bool {
    p.campaigns[(id / 8) as usize] >> (id % 8) & 1 == 1
}
/// `attested`: the Church oracle signed this transaction.
pub fn claim(p: &mut Player, h: &mut House, b: &mut Board, id: u32, attested: bool, now: i64) -> R<(u64, u32)> {
    let i = find(b, id)?;
    let c = b.slots[i];
    if c.active == 0 { return Err(ChurchError::Closed); }
    if claimed(p, id) { return Err(ChurchError::AlreadyClaimed); }
    if c.creator == p.authority { return Err(ChurchError::NotAllowed); }
    if c.kind == MACHINE {
        if !p.machine_plays.iter().any(|m| m.machine_id == c.machine_id && m.plays >= c.goal) { return Err(ChurchError::NotDone); }
    } else if !attested {
        return Err(ChurchError::NotAllowed);
    }
    let chips = u64::from(c.reward_chips) * CHIP;
    if c.budget < chips { return Err(ChurchError::Closed); }
    let day = (now.div_euclid(DAY_S)) as u32;
    if p.campaign_faith_day != day { p.campaign_faith_day = day; p.campaign_faith_used = 0; }
    let faith = c.reward_faith_milli.min(DAILY_FAITH.saturating_sub(p.campaign_faith_used));
    p.campaign_faith_used += faith;
    let applied = add_faith(p, faith);
    p.campaigns[(id / 8) as usize] |= 1 << (id % 8);
    h.escrow_total -= chips;
    if c.from_treasury != 0 {
        // free chips; what the treasury set aside for them now stands behind them in the vault
        h.vault += chips;
        grant_bonus(p, h, chips).map_err(|_| ChurchError::Overflow)?;
    } else {
        p.chips += chips;
        h.chips_outstanding += chips;
    }
    let s = &mut b.slots[i];
    s.budget -= chips;
    s.claims += 1;
    if s.claims >= s.max_claims { s.active = 0; }
    Ok((chips / CHIP, applied))
}
/// Closing only stops it. What is left is collected with `collect`.
pub fn close(b: &mut Board, id: u32, who: &Pubkey, admin: bool) -> R<()> {
    let i = find(b, id)?;
    if b.slots[i].creator != *who && !admin { return Err(ChurchError::NotAllowed); }
    if b.slots[i].active == 0 { return Err(ChurchError::Closed); }
    b.slots[i].active = 0;
    Ok(())
}
/// Returns a closed campaign's unspent rewards: to its creator, or to the treasury. Anyone may call it.
pub fn collect(creator: Option<&mut Player>, h: &mut House, b: &mut Board, id: u32) -> R<u64> {
    let i = find(b, id)?;
    let c = b.slots[i];
    if c.active != 0 { return Err(ChurchError::TooEarly); }
    if c.budget == 0 { return Err(ChurchError::NothingPending); }
    if c.from_treasury != 0 {
        h.treasury += c.budget;
    } else {
        let p = creator.filter(|p| p.authority == c.creator).ok_or(ChurchError::NotAllowed)?;
        p.chips += c.budget;
        h.chips_outstanding += c.budget;
    }
    h.escrow_total -= c.budget;
    b.slots[i].budget = 0;
    Ok(c.budget)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bets::tests::{balanced, rig};
    fn n<'a>() -> New<'a> { New { kind: SOCIAL, title: "Follow us", url: "https://x.com/a", machine_id: 0, goal: 0, reward_chips: 5, reward_faith_milli: 3_000, max_claims: 2 } }
    fn who(b: u8, chips: u64) -> Player { let mut p: Player = bytemuck::Zeroable::zeroed(); p.authority = Pubkey::new_from_array([b; 32]); p.chips = chips * CHIP; p.faith_milli = 20_000; p }
    fn all(chips: u64) -> (Player, Player, House, Board) {
        let (_, mut h) = rig(5_000, 0);
        let (p, q) = (who(1, chips), who(2, 0));
        h.chips_outstanding = p.chips;
        h.total_credited += p.chips;
        (p, q, h, bytemuck::Zeroable::zeroed())
    }
    #[test]
    fn wording_and_limits() {
        check(&n()).unwrap();
        for c in [New { kind: 3, ..n() }, New { title: "ab", ..n() }, New { title: " abc", ..n() }, New { title: "a\u{202e}bc", ..n() }, New { url: "http://x.com", ..n() }, New { url: "", ..n() }, New { url: "https://x.com/ a", ..n() }, New { reward_chips: 51, ..n() }, New { reward_faith_milli: 5_001, ..n() }, New { reward_chips: 0, reward_faith_milli: 0, ..n() }, New { max_claims: 0, ..n() }, New { max_claims: 501, ..n() }, New { goal: 1, ..n() }, New { kind: MACHINE, ..n() }, New { kind: MACHINE, url: "", machine_id: 1, goal: 51, ..n() }] {
            assert_eq!(check(&c), Err(ChurchError::BadArgs), "{} {}", c.title, c.url);
        }
        check(&New { kind: MACHINE, url: "", machine_id: 1, goal: 50, ..n() }).unwrap();
        assert_eq!(cost(5, 2), (10 * CHIP, 10 * CHIP));
        assert_eq!(cost(50, 500), (25_000 * CHIP, 2_500 * CHIP));
    }
    #[test]
    fn a_campaign_from_start_to_refund() {
        let (mut p, mut q, mut h, mut b) = all(30);
        b.index = 1;
        p.faith_milli = 9_999;
        assert_eq!(create(&mut p, &mut h, &mut b, &n(), false, 1), Err(ChurchError::FaithLow));
        p.faith_milli = 10_000;
        assert_eq!(create(&mut p, &mut h, &mut b, &New { max_claims: 5, ..n() }, false, 1), Err(ChurchError::NoChips));
        assert_eq!(create(&mut p, &mut h, &mut b, &New { kind: MACHINE, url: "", machine_id: 1, goal: 1, ..n() }, false, 1), Err(ChurchError::NotAllowed));
        let id = create(&mut p, &mut h, &mut b, &n(), false, 1).unwrap();
        assert_eq!((id, p.chips, h.escrow_total), (128, 10 * CHIP, 10 * CHIP));
        balanced(&h);
        assert_eq!(claim(&mut q, &mut h, &mut b, id, false, 0), Err(ChurchError::NotAllowed), "not attested");
        assert_eq!(claim(&mut p, &mut h, &mut b, id, true, 0), Err(ChurchError::NotAllowed), "your own");
        assert_eq!(claim(&mut q, &mut h, &mut b, id, true, 0), Ok((5, 3_000)));
        assert_eq!((q.chips, q.bonus), (5 * CHIP, 0), "a player paid: real chips");
        assert_eq!(claim(&mut q, &mut h, &mut b, id, true, 0), Err(ChurchError::AlreadyClaimed));
        assert_eq!(collect(Some(&mut p), &mut h, &mut b, id), Err(ChurchError::TooEarly));
        assert_eq!(close(&mut b, id, &q.authority, false), Err(ChurchError::NotAllowed));
        close(&mut b, id, &p.authority, false).unwrap();
        assert_eq!(close(&mut b, id, &p.authority, false), Err(ChurchError::Closed));
        let mut z = who(3, 0);
        assert_eq!(claim(&mut z, &mut h, &mut b, id, true, 0), Err(ChurchError::Closed));
        assert_eq!(collect(Some(&mut z), &mut h, &mut b, id), Err(ChurchError::NotAllowed));
        assert_eq!(collect(Some(&mut p), &mut h, &mut b, id), Ok(5 * CHIP));
        assert_eq!(collect(Some(&mut p), &mut h, &mut b, id), Err(ChurchError::NothingPending));
        assert_eq!((p.chips, h.escrow_total), (15 * CHIP, 0));
        balanced(&h);
    }
    #[test]
    fn the_churchs_own_give_free_chips_and_faith_is_capped() {
        let (_, mut q, mut h, mut b) = all(0);
        let admin = Pubkey::new_from_array([9; 32]);
        assert_eq!(seed(admin, &mut h, &mut b, &New { reward_chips: 50, max_claims: 6, ..n() }, 1), Err(ChurchError::TreasuryLow));
        let ids: Vec<u32> = (0..4).map(|_| seed(admin, &mut h, &mut b, &New { reward_chips: 2, reward_faith_milli: 4_000, ..n() }, 1).unwrap()).collect();
        let v = h.vault;
        let got: Vec<u32> = ids.iter().map(|i| claim(&mut q, &mut h, &mut b, *i, true, 5).unwrap().1).collect();
        assert_eq!(got, vec![4_000, 4_000, 2_000, 0]);
        assert_eq!((q.chips, q.bonus, h.vault - v), (0, 8 * CHIP, 8 * CHIP));
        close(&mut b, ids[0], &q.authority, true).unwrap();
        let t = h.treasury;
        assert_eq!(collect(None, &mut h, &mut b, ids[0]), Ok(2 * CHIP));
        assert_eq!(h.treasury - t, 2 * CHIP);
        balanced(&h);
    }
    #[test]
    fn machine_campaigns_need_the_plays_and_slots_are_reused() {
        let (mut p, mut q, mut h, mut b) = all(5_000);
        let id = create(&mut p, &mut h, &mut b, &New { kind: MACHINE, url: "", machine_id: 7, goal: 3, max_claims: 1, ..n() }, true, 1).unwrap();
        q.machine_plays[1] = crate::state::MachinePlays { machine_id: 7, plays: 2 };
        assert_eq!(claim(&mut q, &mut h, &mut b, id, true, 0), Err(ChurchError::NotDone));
        q.machine_plays[1].plays = 3;
        claim(&mut q, &mut h, &mut b, id, false, 0).unwrap();
        assert_eq!(b.slots[find(&b, id).unwrap()].active, 0, "the last claim closes it");
        for i in 0..BOARD_SLOTS as i64 { create(&mut p, &mut h, &mut b, &New { max_claims: 1, ..n() }, false, 10 + i).unwrap(); }
        assert_eq!(create(&mut p, &mut h, &mut b, &New { max_claims: 1, ..n() }, false, 99), Err(ChurchError::BoardFull), "20 open");
        assert!(find(&b, id).is_err(), "the closed one made room");
        b.slots[0].active = 0;
        assert_eq!(create(&mut p, &mut h, &mut b, &New { max_claims: 1, ..n() }, false, 99), Err(ChurchError::BoardFull), "its refund is still there");
        b.next = BOARD_IDS;
        assert_eq!(create(&mut p, &mut h, &mut b, &n(), false, 99), Err(ChurchError::BoardFull));
        balanced(&h);
    }
}
