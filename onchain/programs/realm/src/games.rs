//! Pure game tables: the same numbers as the NEAR contract and `rules.ts`, checked by the shared test vectors.
//! Payouts are exact: 1.94x of 10 chips is 19.4.

use crate::constants::CHIP;

pub const SLOTS: u8 = 0;
pub const COIN: u8 = 1;
pub const DICE: u8 = 2;
pub const ROULETTE: u8 = 3;
pub const WHEEL: u8 = 4;
pub const HARMONY: u8 = 5;
pub const BLACKJACK: u8 = 6;
pub const MARKET: u8 = 7;

/// seven, diamond, clover, coin, cross
const SLOT_W: [u32; 5] = [4, 8, 14, 24, 50];
const SLOT_TRIPLE: [u64; 5] = [100, 40, 15, 8, 3];
pub const WHEEL_PRIZES: [(u32, u32); 6] = [(10, 30), (25, 30), (50, 20), (100, 15), (250, 4), (500, 1)];
/// free chips. Small on purpose: 50 LUCK is worth about 31 chips of house edge (the test below)
pub const HARMONY_PRIZES: [(u32, u32); 4] = [(10, 40), (20, 30), (40, 20), (100, 9)];
const HARMONY_JACKPOT_AT: u32 = 99;
const RED: [u8; 18] = [1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36];
pub const COIN_PAY_BPS: u64 = 19_400;
pub const DICE_OU_BPS: u64 = 22_800;
pub const DICE_SEVEN_BPS: u64 = 57_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct Resolved {
    /// lamports, before blessing. 0 when `jackpot`
    pub base: u64,
    /// slots: 3 symbols; coin: 0 heads, 1 tails; dice: 2 faces; roulette: number, colour (0 green, 1 red, 2 black);
    /// wheel and harmony: prize index (255 = jackpot)
    pub outcome: [u8; 4],
    pub jackpot: bool,
}

pub fn mul_shift(draw: u32, n: u32) -> u32 {
    ((u64::from(draw) * u64::from(n)) >> 32) as u32
}
/// 32 random bytes become eight draws
pub fn draws_of(h: &[u8; 32]) -> [u32; 8] {
    let mut d = [0u32; 8];
    for (k, v) in d.iter_mut().enumerate() {
        let i = k * 4;
        *v = u32::from_le_bytes([h[i], h[i + 1], h[i + 2], h[i + 3]]);
    }
    d
}
pub fn is_meter_game(game: u8) -> bool {
    game == WHEEL || game == HARMONY
}
pub fn blessing_bps(faith_milli: u32) -> u16 {
    match faith_milli / 1_000 {
        f if f >= 100 => 300,
        f if f >= 75 => 250,
        f if f >= 50 => 150,
        f if f >= 25 => 50,
        _ => 0,
    }
}
pub fn valid_pick(game: u8, pick: u8) -> bool {
    match game {
        SLOTS | WHEEL | HARMONY => pick == 0,
        COIN => pick <= 1,
        DICE => pick <= 3,
        ROULETTE => pick <= 36 || (100..=105).contains(&pick) || (110..=112).contains(&pick) || (120..=122).contains(&pick),
        _ => false,
    }
}
/// The most a bet can pay, before blessing (that comes from the treasury).
pub fn max_payout(game: u8, wager: u64) -> u64 {
    let chips = wager / CHIP;
    match game {
        SLOTS => chips * 100 * CHIP,
        COIN => times(wager, COIN_PAY_BPS),
        DICE => times(wager, DICE_SEVEN_BPS),
        ROULETTE => chips * 36 * CHIP,
        // the wheels pay free chips (and the jackpot its own pool): nothing to hold
        _ => 0,
    }
}
fn times(wager: u64, bps: u64) -> u64 {
    (u128::from(wager) * u128::from(bps) / 10_000) as u64
}
fn weighted(draw: u32, table: &[(u32, u32)]) -> usize {
    let r = mul_shift(draw, 100);
    let mut acc = 0;
    for (i, (_, w)) in table.iter().enumerate() {
        acc += w;
        if r < acc {
            return i;
        }
    }
    table.len() - 1
}
fn reel(draw: u32) -> usize {
    let r = mul_shift(draw, 100);
    let mut acc = 0;
    for (i, w) in SLOT_W.iter().enumerate() {
        acc += w;
        if r < acc {
            return i;
        }
    }
    4
}
pub fn resolve(game: u8, d: &[u32; 8], pick: u8, wager: u64) -> Resolved {
    let chips = wager / CHIP;
    match game {
        SLOTS => {
            let (a, b, c) = (reel(d[0]), reel(d[1]), reel(d[2]));
            let x = if a == b && b == c { SLOT_TRIPLE[a] } else { u64::from(a == b || b == c) };
            Resolved { base: chips * x * CHIP, outcome: [a as u8, b as u8, c as u8, 0], jackpot: false }
        }
        COIN => {
            let side = mul_shift(d[0], 2) as u8;
            Resolved { base: if side == pick { times(wager, COIN_PAY_BPS) } else { 0 }, outcome: [side, 0, 0, 0], jackpot: false }
        }
        DICE => {
            let (a, b) = (mul_shift(d[0], 6) + 1, mul_shift(d[1], 6) + 1);
            let sum = a + b;
            let bps = match pick {
                0 if sum < 7 => DICE_OU_BPS,
                1 if sum == 7 => DICE_SEVEN_BPS,
                2 if sum > 7 => DICE_OU_BPS,
                // the field: 2 and 12 pay 3x, 3 4 9 10 11 pay 2x
                3 => match sum {
                    2 | 12 => 30_000,
                    3 | 4 | 9 | 10 | 11 => 20_000,
                    _ => 0,
                },
                _ => 0,
            };
            Resolved { base: times(wager, bps), outcome: [a as u8, b as u8, 0, 0], jackpot: false }
        }
        ROULETTE => {
            let n = mul_shift(d[0], 37) as u8;
            let red = RED.binary_search(&n).is_ok();
            let x = if pick <= 36 {
                if n == pick { 36 } else { 0 }
            } else if n == 0 {
                0
            } else {
                match pick {
                    100 => if red { 2 } else { 0 },
                    101 => if !red { 2 } else { 0 },
                    102 => if n % 2 == 1 { 2 } else { 0 },
                    103 => if n % 2 == 0 { 2 } else { 0 },
                    104 => if n <= 18 { 2 } else { 0 },
                    105 => if n >= 19 { 2 } else { 0 },
                    110..=112 => if (n - 1) / 12 == pick - 110 { 3 } else { 0 },
                    120..=122 => if (n - 1) % 3 == pick - 120 { 3 } else { 0 },
                    _ => 0,
                }
            };
            Resolved { base: chips * x * CHIP, outcome: [n, if n == 0 { 0 } else if red { 1 } else { 2 }, 0, 0], jackpot: false }
        }
        WHEEL => {
            let i = weighted(d[0], &WHEEL_PRIZES);
            Resolved { base: u64::from(WHEEL_PRIZES[i].0) * CHIP, outcome: [i as u8, 0, 0, 0], jackpot: false }
        }
        HARMONY => {
            if mul_shift(d[0], 100) >= HARMONY_JACKPOT_AT {
                return Resolved { base: 0, outcome: [255, 0, 0, 0], jackpot: true };
            }
            let i = weighted(d[0], &HARMONY_PRIZES);
            Resolved { base: u64::from(HARMONY_PRIZES[i].0) * CHIP, outcome: [i as u8, 0, 0, 0], jackpot: false }
        }
        _ => Resolved::default(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const SYMS: [&str; 5] = ["seven", "diamond", "clover", "coin", "cross"];

    /// The 1,005 vectors shared with `packages/sim` and the NEAR contract: the VRF output takes the place of `h`.
    #[test]
    fn shared_vectors() {
        let doc: serde_json::Value = serde_json::from_str(include_str!("../vectors.json")).unwrap();
        let all: Vec<_> = doc["fixed"].as_array().unwrap().iter().chain(doc["random"].as_array().unwrap()).collect();
        assert_eq!(all.len(), 1005);
        for c in all {
            let hex = c["h"].as_str().unwrap();
            let mut h = [0u8; 32];
            for i in 0..32 { h[i] = u8::from_str_radix(&hex[2 * i..2 * i + 2], 16).unwrap(); }
            let d = draws_of(&h);
            let s = resolve(SLOTS, &d, 0, CHIP);
            let want: Vec<&str> = c["slots"].as_array().unwrap().iter().map(|v| v.as_str().unwrap()).collect();
            assert_eq!(s.outcome[..3].iter().map(|i| SYMS[*i as usize]).collect::<Vec<_>>(), want);
            assert_eq!(s.base, c["slots_pay_x"].as_u64().unwrap() * CHIP);
            assert_eq!(["H", "T"][resolve(COIN, &d, 0, 100 * CHIP).outcome[0] as usize], c["coin"].as_str().unwrap());
            let dice = resolve(DICE, &d, 0, CHIP).outcome;
            assert_eq!([u64::from(dice[0]), u64::from(dice[1])], [c["dice"][0].as_u64().unwrap(), c["dice"][1].as_u64().unwrap()]);
            let r = resolve(ROULETTE, &d, 0, CHIP).outcome;
            assert_eq!((u64::from(r[0]), ["green", "red", "black"][r[1] as usize]), (c["roulette_n"].as_u64().unwrap(), c["roulette_color"].as_str().unwrap()));
            assert_eq!(resolve(WHEEL, &d, 0, 0).base, c["wheel"].as_u64().unwrap() * CHIP);
            let hm = resolve(HARMONY, &d, 0, 0);
            if c["harmony"] == "JACKPOT" { assert!(hm.jackpot); } else { let i = [150, 300, 600, 1500].iter().position(|v| *v == c["harmony"].as_u64().unwrap()).unwrap(); assert_eq!(hm.base, u64::from(HARMONY_PRIZES[i].0) * CHIP); } // the vectors hold the NEAR prizes: same slice, smaller prize
        }
    }

    /// every result of every bet, against the returns the design promises; and never above the reserved maximum
    #[test]
    fn exact_returns_and_holds() {
        let at = |face: u32, n: u32| { let mut v = (((u64::from(face) << 32) + u64::from(n) - 1) / u64::from(n)) as u32; while mul_shift(v, n) < face { v += 1; } v };
        let bet = 10_000 * CHIP;
        let mut coin = 0;
        for s in 0..2 { coin += resolve(COIN, &[at(s, 2), 0, 0, 0, 0, 0, 0, 0], 0, bet).base; }
        assert_eq!(coin, 19_400 * CHIP);
        for (pick, want) in [(0u8, 15 * 22_800u64), (1, 6 * 57_000), (2, 15 * 22_800), (3, 34 * 10_000)] {
            let mut t = 0;
            for a in 0..6 { for b in 0..6 { t += resolve(DICE, &[at(a, 6), at(b, 6), 0, 0, 0, 0, 0, 0], pick, bet).base / CHIP; } }
            assert_eq!(t, want, "dice {pick}");
        }
        for pick in (0..=36u8).chain(100..=105).chain(110..=112).chain(120..=122) {
            let mut t = 0;
            for n in 0..37 { let r = resolve(ROULETTE, &[at(n, 37), 0, 0, 0, 0, 0, 0, 0], pick, CHIP); assert!(r.base <= max_payout(ROULETTE, CHIP)); t += r.base / CHIP; }
            assert_eq!(t, 36, "roulette {pick}");
        }
        let mut back = 0u64;
        for a in 0..100 { for b in 0..100 { for c in 0..100 { let r = resolve(SLOTS, &[at(a, 100), at(b, 100), at(c, 100), 0, 0, 0, 0, 0], 0, CHIP); assert!(r.base <= max_payout(SLOTS, CHIP)); back += r.base / CHIP; } } }
        assert!((900_000..970_000).contains(&back), "slots return {back} per million");
    }

    /// What every game gives back through LUCK must stay below what the house keeps, or grinding LUCK beats the house.
    /// A free chip is worth its face at most, so this is the worst case; 75 bps of every stake also goes to the church
    /// and the jackpot, which is not the house's to spend.
    #[test]
    fn luck_never_costs_more_than_the_edge() {
        let per_luck_wheel = WHEEL_PRIZES.iter().map(|(p, w)| f64::from(p * w)).sum::<f64>() / 100.0 / 100.0;
        // Harmony: 50 LUCK, and one chance in a hundred at a pool of about 250 real chips
        let per_luck_harmony = (HARMONY_PRIZES.iter().map(|(p, w)| f64::from(p * w)).sum::<f64>() / 100.0 + 2.5) / 50.0;
        let slots: f64 = { let w = [4.0, 8.0, 14.0, 24.0, 50.0]; let mut r = 0.0; for a in 0..5 { for b in 0..5 { for c in 0..5 { r += w[a] * w[b] * w[c] / 1e6 * if a == b && b == c { SLOT_TRIPLE[a] as f64 } else if a == b || b == c { 1.0 } else { 0.0 }; } } } r };
        for (game, edge) in [(SLOTS, 1.0 - slots), (COIN, 0.03), (DICE, 0.05), (ROULETTE, 1.0 / 37.0), (BLACKJACK, 0.0100), (MARKET, 0.05)] {
            let luck = 80.0 * crate::constants::LUCK_WEIGHT[usize::from(game)] as f64 / 100.0 / 1000.0;
            let back = luck * per_luck_wheel.max(per_luck_harmony);
            println!("game {game}: edge {:.2}%, LUCK gives back {:.2}%", edge * 100.0, back * 100.0);
            assert!(back < edge, "game {game}: {back} of {edge}");
        }
    }
}
