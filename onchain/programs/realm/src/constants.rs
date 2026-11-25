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
pub const SEED_MARKET: &[u8] = b"market";
/// an address nobody owns, one per 60 rounds: it only makes the record of those rounds easy to find
pub const SEED_ROUNDS: &[u8] = b"rounds";

pub const DELEGATION_PROGRAM: Pubkey = pubkey!("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh");

/// cranks (Hydra) and the price feed, on the rollup
pub const HYDRA: Pubkey = pubkey!("eHyd5BU8QffvHi4GnXwxrK4WpS7pM2x9UGKHBWii7mf");
pub const EPHEMERAL_VAULT: Pubkey = pubkey!("MagicVau1t999999999999999999999999999999999");
pub const MAGIC_PROGRAM: Pubkey = pubkey!("Magic11111111111111111111111111111111111111");
pub const PRICE_PROGRAM: Pubkey = pubkey!("PriCems5tHihc6UDXDjzjeawomAwBduWMGAi8ZUjppd");
pub const INSTRUCTIONS_SYSVAR: Pubkey = pubkey!("Sysvar1nstructions1111111111111111111111111");
pub const MARKET_ROTATE_AT: u32 = 9;

pub const FLAG_WELCOME: u8 = 1;
pub const FLAG_PLOT_GATE: u8 = 2;
