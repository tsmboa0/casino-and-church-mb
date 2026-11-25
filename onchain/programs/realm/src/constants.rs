use anchor_lang::prelude::*;

/// 1 chip = 0.001 SOL. Everything is kept in lamports.
pub const CHIP: u64 = 1_000_000;
pub const METER_MAX: u32 = 100_000;
pub const REALM_COOLDOWN_S: i64 = 3;
pub const DAY_S: i64 = 86_400;
pub const HOUR_S: i64 = 3_600;
/// A delegation allows 10 commits. At this many, cash-out leaves the rollup too, and the player is delegated again.
pub const ROTATE_AT_COMMITS: u32 = 8;
pub const MAX_COMMITTABLE: usize = 10_240;

pub const SEED_CONFIG: &[u8] = b"config";
pub const SEED_BANK: &[u8] = b"bank";
pub const SEED_PURSE: &[u8] = b"purse";
pub const SEED_HOUSE_PURSE: &[u8] = b"house_purse";
pub const SEED_HOUSE: &[u8] = b"house";
pub const SEED_PLAYER: &[u8] = b"player";

pub const DELEGATION_PROGRAM: Pubkey = pubkey!("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh");

pub const FLAG_WELCOME: u8 = 1;
pub const FLAG_PLOT_GATE: u8 = 2;
