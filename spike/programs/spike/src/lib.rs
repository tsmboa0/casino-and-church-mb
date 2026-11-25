//! M1 spike: throwaway program that proves the risky MagicBlock parts (MAGICBLOCK_PLAN.md section 22). Not the game.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke_signed;
use solana_instructions_sysvar::{load_current_index_checked, load_instruction_at_checked};
use anchor_lang::Discriminator;
use ephemeral_rollups_sdk::anchor::{commit, delegate, ephemeral, vrf};
use ephemeral_rollups_sdk::cpi::DelegateConfig;
use ephemeral_rollups_sdk::ephem::{CallHandler, MagicIntentBundleBuilder};
use ephemeral_rollups_sdk::vrf::consts::{program_identity_pubkey, scoped_vrf_identity_const, DEFAULT_EPHEMERAL_QUEUE};
use ephemeral_rollups_sdk::vrf::instructions::{
    create_request_randomness_ix_const, RequestRandomnessParams,
};
use ephemeral_rollups_sdk::vrf::types::SerializableAccountMeta;
use ephemeral_rollups_sdk::{ActionArgs, ShortAccountMeta};
use session_keys::{session_auth_or, Session, SessionError, SessionTokenV2};

declare_id!("55dcwejoNy2ggstgmeCrYPQfKwenYK1wrokuTSyZTSkp");

const PROGRAM_IDENTITY: Pubkey = program_identity_pubkey(&crate::ID);
/// Scoped VRF identity, derived at COMPILE time. SDK 0.18.0's #[vrf_callback] derives it at runtime and uses the whole
/// compute budget (measured: 272k of 272k), so every callback fails. Same check, constant instead.
const VRF_IDENTITY: Pubkey = Pubkey::new_from_array(scoped_vrf_identity_const(&crate::ID).0);
const DLP: Pubkey = pubkey!("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh");
const HYDRA_ER: Pubkey = pubkey!("eHyd5BU8QffvHi4GnXwxrK4WpS7pM2x9UGKHBWii7mf");
const MAGIC_PROGRAM: Pubkey = pubkey!("Magic11111111111111111111111111111111111111");
const EPH_VAULT: Pubkey = pubkey!("MagicVau1t999999999999999999999999999999999");
const ORACLE: Pubkey = pubkey!("PriCems5tHihc6UDXDjzjeawomAwBduWMGAi8ZUjppd");
const INSTRUCTIONS_SYSVAR: Pubkey = pubkey!("Sysvar1nstructions1111111111111111111111111");
const CHIP: u64 = 1_000_000;
const ROUND_S: i64 = 60;
const GRACE_S: i64 = 20;
const RING: usize = 96;

#[ephemeral]
#[program]
pub mod spike {
    use super::*;

    // ---------------------------------------------------------------- L1

    pub fn init(ctx: Context<Init>, keeper: Pubkey, feed: Pubkey, validator: Pubkey) -> Result<()> {
        let c = &mut ctx.accounts.config;
        c.admin = ctx.accounts.admin.key();
        c.keeper = keeper;
        c.feed = feed;
        c.validator = validator;
        Ok(())
    }

    pub fn set_fail(ctx: Context<AdminConfig>, fail: bool) -> Result<()> {
        ctx.accounts.config.fail_payout = fail;
        Ok(())
    }

    pub fn set_crank(ctx: Context<AdminConfig>, crank: Pubkey) -> Result<()> {
        ctx.accounts.config.crank = crank;
        Ok(())
    }

    pub fn delegate_house(ctx: Context<DelegateHouse>) -> Result<()> {
        ctx.accounts.delegate_house(
            &ctx.accounts.admin,
            &[b"house"],
            DelegateConfig { validator: Some(ctx.accounts.config.validator), ..Default::default() },
        )?;
        Ok(())
    }

    pub fn delegate_market(ctx: Context<DelegateMarket>) -> Result<()> {
        ctx.accounts.delegate_market(
            &ctx.accounts.admin,
            &[b"market"],
            DelegateConfig { validator: Some(ctx.accounts.config.validator), ..Default::default() },
        )?;
        Ok(())
    }

    /// Purse + Player in one go, and Player straight onto the rollup.
    pub fn open_account(ctx: Context<OpenAccount>) -> Result<()> {
        let owner = ctx.accounts.owner.key();
        ctx.accounts.purse.owner = owner;
        let bump = ctx.bumps.player;
        let seeds: &[&[u8]] = &[b"player", owner.as_ref(), &[bump]];
        let space = 8 + Player::INIT_SPACE;
        anchor_lang::system_program::create_account(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.key(),
                anchor_lang::system_program::CreateAccount {
                    from: ctx.accounts.payer.to_account_info(),
                    to: ctx.accounts.player.to_account_info(),
                },
                &[seeds],
            ),
            Rent::get()?.minimum_balance(space),
            space as u64,
            &crate::ID,
        )?;
        let p = Player { authority: owner, bump, ..Default::default() };
        {
            let mut data = ctx.accounts.player.try_borrow_mut_data()?;
            p.try_serialize(&mut &mut data[..])?;
        }
        ctx.accounts.delegate_player(
            &ctx.accounts.payer,
            &[b"player", owner.as_ref()],
            DelegateConfig { validator: Some(ctx.accounts.config.validator), ..Default::default() },
        )?;
        Ok(())
    }

    pub fn redelegate(ctx: Context<Redelegate>) -> Result<()> {
        let owner = ctx.accounts.owner.key();
        ctx.accounts.delegate_player(
            &ctx.accounts.payer,
            &[b"player", owner.as_ref()],
            DelegateConfig { validator: Some(ctx.accounts.config.validator), ..Default::default() },
        )?;
        Ok(())
    }

    pub fn buy(ctx: Context<Buy>, lamports: u64) -> Result<()> {
        require!(lamports >= CHIP && lamports % CHIP == 0, SpikeError::BadAmount);
        anchor_lang::system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.key(),
                anchor_lang::system_program::Transfer {
                    from: ctx.accounts.owner.to_account_info(),
                    to: ctx.accounts.bank.to_account_info(),
                },
            ),
            lamports,
        )?;
        let p = &mut ctx.accounts.purse;
        p.deposited = p.deposited.checked_add(lamports).unwrap();
        Ok(())
    }

    /// Permissionless: amount and destination are fixed by state. Also the Magic Action handler.
    pub fn settle_payout(ctx: Context<SettlePayout>) -> Result<()> {
        require!(!ctx.accounts.config.fail_payout, SpikeError::ForcedFailure);
        let info = ctx.accounts.player.to_account_info();
        require!(info.owner == &DLP || info.owner == &crate::ID, SpikeError::BadPlayer);
        let data = info.try_borrow_data()?;
        let player = Player::try_deserialize(&mut &data[..])?;
        drop(data);
        require_keys_eq!(player.authority, ctx.accounts.purse.owner, SpikeError::BadPlayer);
        let purse = &mut ctx.accounts.purse;
        let due = player.withdrawn.checked_sub(purse.paid_out).unwrap();
        if due == 0 {
            return Ok(());
        }
        purse.paid_out += due;
        purse.payouts += 1;
        let bank = ctx.accounts.bank.to_account_info();
        let wallet = ctx.accounts.wallet.to_account_info();
        **bank.try_borrow_mut_lamports()? -= due;
        **wallet.try_borrow_mut_lamports()? += due;
        Ok(())
    }

    // ---------------------------------------------------------------- rollup: money

    pub fn sync_deposit(ctx: Context<SyncDeposit>) -> Result<()> {
        sync(&mut ctx.accounts.player, &ctx.accounts.purse)
    }

    pub fn cash_out(ctx: Context<CashOut>, chips: u64) -> Result<()> {
        {
            let p = &mut ctx.accounts.player;
            require!(p.pending == 0, SpikeError::Busy);
            let amount = chips.checked_mul(CHIP).unwrap();
            require!(amount > 0 && p.chips >= amount, SpikeError::BadAmount);
            p.chips -= amount;
            p.withdrawn += amount;
            p.commits += 1;
        }
        ctx.accounts.player.exit(&crate::ID)?;
        let key = |k: Pubkey| k.to_bytes().into();
        let action = CallHandler {
            destination_program: crate::ID,
            accounts: vec![
                ShortAccountMeta { pubkey: key(ctx.accounts.config.key()), is_writable: false },
                ShortAccountMeta { pubkey: key(ctx.accounts.bank.key()), is_writable: true },
                ShortAccountMeta { pubkey: key(ctx.accounts.purse.key()), is_writable: true },
                ShortAccountMeta { pubkey: key(ctx.accounts.authority.key()), is_writable: true },
                ShortAccountMeta { pubkey: key(ctx.accounts.player.key()), is_writable: false },
            ],
            args: ActionArgs::new(anchor_lang::InstructionData::data(&crate::instruction::SettlePayout {})),
            escrow_authority: ctx.accounts.authority.to_account_info(),
            compute_units: 200_000,
        };
        MagicIntentBundleBuilder::new(
            ctx.accounts.authority.to_account_info(),
            ctx.accounts.magic_context.to_account_info(),
            ctx.accounts.magic_program.to_account_info(),
        )
        .commit(&[ctx.accounts.player.to_account_info()])
        .add_post_commit_actions([action])
        .build_and_invoke()?;
        Ok(())
    }

    pub fn commit_only(ctx: Context<CommitOnly>) -> Result<()> {
        ctx.accounts.player.commits += 1;
        ctx.accounts.player.exit(&crate::ID)?;
        MagicIntentBundleBuilder::new(
            ctx.accounts.payer.to_account_info(),
            ctx.accounts.magic_context.to_account_info(),
            ctx.accounts.magic_program.to_account_info(),
        )
        .commit(&[ctx.accounts.player.to_account_info()])
        .build_and_invoke()?;
        Ok(())
    }

    pub fn undelegate_player(ctx: Context<CommitOnly>) -> Result<()> {
        MagicIntentBundleBuilder::new(
            ctx.accounts.payer.to_account_info(),
            ctx.accounts.magic_context.to_account_info(),
            ctx.accounts.magic_program.to_account_info(),
        )
        .commit_and_undelegate(&[ctx.accounts.player.to_account_info()])
        .build_and_invoke()?;
        Ok(())
    }

    // ---------------------------------------------------------------- rollup: VRF

    #[session_auth_or(
        ctx.accounts.player.authority == ctx.accounts.signer.key(),
        SessionError::InvalidToken
    )]
    pub fn flip(ctx: Context<Flip>, pick: u8, client_seed: [u8; 32]) -> Result<()> {
        let key = ctx.accounts.player.key();
        let (seq, seed) = {
            let p = &mut ctx.accounts.player;
            sync(p, &ctx.accounts.purse)?;
            require!(p.pending == 0, SpikeError::Busy);
            require!(p.chips >= CHIP, SpikeError::BadAmount);
            p.chips -= CHIP;
            p.seq += 1;
            p.pending = p.seq;
            p.pick = pick;
            p.placed_slot = Clock::get()?.slot;
            let mut seed = client_seed;
            for (i, b) in p.seq.to_le_bytes().iter().enumerate() {
                seed[i] ^= b;
            }
            (p.seq, seed)
        };
        let ix = create_request_randomness_ix_const(
            RequestRandomnessParams {
                payer: ctx.accounts.signer.key(),
                oracle_queue: ctx.accounts.oracle_queue.key(),
                callback_program_id: crate::ID,
                callback_discriminator: instruction::SettleFlip::DISCRIMINATOR.to_vec(),
                caller_seed: seed,
                accounts_metas: Some(vec![
                    SerializableAccountMeta { pubkey: key, is_signer: false, is_writable: true },
                    SerializableAccountMeta { pubkey: ctx.accounts.house.key(), is_signer: false, is_writable: true },
                ]),
                callback_args: Some(seq.to_le_bytes().to_vec()),
                ..Default::default()
            },
            PROGRAM_IDENTITY,
        );
        ctx.accounts.invoke_signed_vrf(&ctx.accounts.signer.to_account_info(), &ix)?;
        Ok(())
    }

    /// Called by the VRF program. Never errors on a stale bet.
    pub fn settle_flip(ctx: Context<SettleFlip>, randomness: [u8; 32], seq: u64) -> Result<()> {
        let p = &mut ctx.accounts.player;
        let h = &mut ctx.accounts.house;
        if p.pending == 0 || p.pending != seq {
            h.stale += 1;
            return Ok(());
        }
        p.pending = 0;
        let draw = u32::from_le_bytes([randomness[0], randomness[1], randomness[2], randomness[3]]);
        let side = ((u64::from(draw) * 2) >> 32) as u8;
        p.last = side;
        p.settled += 1;
        p.settled_slot = Clock::get()?.slot;
        p.vrf = randomness;
        if side == p.pick {
            p.wins += 1;
            p.chips += CHIP * 2;
        }
        h.settled += 1;
        // how much compute the callback may use (M1 test 6): burn on request
        let mut x = 1u64;
        for i in 0..h.burn {
            x = core::hint::black_box(x.wrapping_mul(6364136223846793005).wrapping_add(u64::from(i)));
        }
        h.sink = x;
        Ok(())
    }

    pub fn set_burn(ctx: Context<AdminHouse>, burn: u32) -> Result<()> {
        ctx.accounts.house.burn = burn;
        Ok(())
    }

    pub fn refund(ctx: Context<Refund>) -> Result<()> {
        let p = &mut ctx.accounts.player;
        require!(p.pending != 0, SpikeError::BadAmount);
        p.pending = 0;
        p.chips += CHIP;
        p.refunds += 1;
        Ok(())
    }

    // ---------------------------------------------------------------- rollup: market + crank

    pub fn market_start(ctx: Context<MarketAdmin>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let m = &mut ctx.accounts.market;
        m.enabled = true;
        m.epoch = 1;
        m.open_lock_ts = now + ROUND_S;
        m.live_epoch = 0;
        m.last_call_ts = now;
        m.max_gap_s = 0;
        m.calls = 0;
        m.closed = 0;
        m.voided = 0;
        m.by_crank = 0;
        m.by_keeper = 0;
        Ok(())
    }

    /// Created by the House PDA, so the crank's address proves who made it.
    pub fn crank_create(ctx: Context<CrankCreate>, seed: [u8; 32], interval_slots: u64, tip: u64) -> Result<()> {
        let tick = Instruction {
            program_id: crate::ID,
            accounts: vec![
                AccountMeta::new(ctx.accounts.market.key(), false),
                AccountMeta::new_readonly(ctx.accounts.config.key(), false),
                AccountMeta::new_readonly(ctx.accounts.config.feed, false),
                AccountMeta::new_readonly(INSTRUCTIONS_SYSVAR, false),
                AccountMeta::new_readonly(crate::ID, false), // no keeper
            ],
            data: anchor_lang::InstructionData::data(&crate::instruction::MarketTick {}),
        };
        let mut d = vec![0u8];
        d.extend_from_slice(&seed);
        d.extend_from_slice(ctx.accounts.house.key().as_ref()); // authority
        d.extend_from_slice(&Clock::get()?.slot.to_le_bytes()); // start here: 0 would make Hydra catch up from slot 0, firing every slot
        d.extend_from_slice(&interval_slots.to_le_bytes());
        d.extend_from_slice(&0u64.to_le_bytes()); // 0 = forever
        d.extend_from_slice(&tip.to_le_bytes());
        d.extend_from_slice(&0u32.to_le_bytes());
        d.push(tick.accounts.len() as u8);
        d.extend_from_slice(&(tick.data.len() as u16).to_le_bytes());
        d.extend_from_slice(tick.program_id.as_ref());
        for m in &tick.accounts {
            d.push(if m.is_writable { 2 } else { 0 });
            d.extend_from_slice(m.pubkey.as_ref());
        }
        d.extend_from_slice(&tick.data);
        let ix = Instruction {
            program_id: HYDRA_ER,
            accounts: vec![
                AccountMeta::new(ctx.accounts.house.key(), true),
                AccountMeta::new(ctx.accounts.crank.key(), false),
                AccountMeta::new(EPH_VAULT, false),
                AccountMeta::new_readonly(MAGIC_PROGRAM, false),
            ],
            data: d,
        };
        invoke_signed(
            &ix,
            &[
                ctx.accounts.house.to_account_info(),
                ctx.accounts.crank.to_account_info(),
                ctx.accounts.eph_vault.to_account_info(),
                ctx.accounts.magic_program.to_account_info(),
                ctx.accounts.hydra.to_account_info(),
            ],
            &[&[b"house", &[ctx.bumps.house]]],
        )?;
        Ok(())
    }

    pub fn crank_cancel(ctx: Context<CrankCreate>) -> Result<()> {
        let ix = Instruction {
            program_id: HYDRA_ER,
            accounts: vec![
                AccountMeta::new(ctx.accounts.house.key(), true),
                AccountMeta::new(ctx.accounts.crank.key(), false),
                AccountMeta::new(ctx.accounts.house.key(), false),
                AccountMeta::new(EPH_VAULT, false),
                AccountMeta::new_readonly(MAGIC_PROGRAM, false),
            ],
            data: vec![2],
        };
        invoke_signed(
            &ix,
            &[
                ctx.accounts.house.to_account_info(),
                ctx.accounts.crank.to_account_info(),
                ctx.accounts.eph_vault.to_account_info(),
                ctx.accounts.magic_program.to_account_info(),
                ctx.accounts.hydra.to_account_info(),
            ],
            &[&[b"house", &[ctx.bumps.house]]],
        )?;
        Ok(())
    }

    pub fn market_tick(ctx: Context<MarketTick>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let m = &mut ctx.accounts.market;
        let crank = is_crank(&ctx.accounts.instructions, &ctx.accounts.config.crank)?;
        if crank {
            m.calls += 1;
            let gap = now - m.last_call_ts;
            if gap > m.max_gap_s {
                m.max_gap_s = gap;
            }
            m.last_call_ts = now;
        }
        if !m.enabled || now < m.open_lock_ts {
            return Ok(());
        }
        if now > m.open_lock_ts + GRACE_S {
            m.voided += if m.live_epoch > 0 { 2 } else { 1 };
            m.live_epoch = 0;
            m.epoch += 1;
            m.open_lock_ts = now + ROUND_S;
            return Ok(());
        }
        let keeper = ctx
            .accounts
            .keeper
            .as_ref()
            .map(|k| k.key() == ctx.accounts.config.keeper)
            .unwrap_or(false);
        require!(crank || keeper, SpikeError::NotAllowed);
        let Some((cents, publish)) = fresh_price(&ctx.accounts.feed, now)? else {
            m.stale_price += 1;
            return Ok(());
        };
        if crank {
            m.by_crank += 1;
        } else {
            m.by_keeper += 1;
        }
        if m.live_epoch > 0 {
            let i = (m.closed as usize) % RING;
            m.ring[i] = Round {
                epoch: m.live_epoch as u32,
                lock_c: m.live_lock_c,
                close_c: cents,
                closed_ts: now as u32,
                late_s: (now - m.open_lock_ts) as u16,
                price_age_s: (now - publish).max(0) as u16,
            };
            m.closed += 1;
        }
        m.live_epoch = m.epoch;
        m.live_lock_c = cents;
        m.epoch += 1;
        m.open_lock_ts = now + ROUND_S;
        Ok(())
    }
}

// -------------------------------------------------------------------- helpers

fn sync(p: &mut Player, purse: &Purse) -> Result<()> {
    require_keys_eq!(p.authority, purse.owner, SpikeError::BadPlayer);
    let due = purse.deposited.saturating_sub(p.credited);
    if due > 0 {
        p.credited += due;
        p.chips += due;
        p.synced_slot = Clock::get()?.slot;
    }
    Ok(())
}

fn is_crank(instructions: &AccountInfo, expected: &Pubkey) -> Result<bool> {
    let k = load_current_index_checked(instructions)? as usize;
    if k == 0 {
        return Ok(false);
    }
    let prev = load_instruction_at_checked(k - 1, instructions)?;
    Ok(prev.program_id == HYDRA_ER
        && prev.data.first() == Some(&1)
        && prev.accounts.first().map(|a| a.pubkey == *expected).unwrap_or(false))
}

/// (US cents, publish time). Layout verified live: price i64 at 73, publish time i64 at 93, exponent always -8.
fn fresh_price(feed: &AccountInfo, now: i64) -> Result<Option<(u32, i64)>> {
    require_keys_eq!(*feed.owner, ORACLE, SpikeError::BadFeed);
    let d = feed.try_borrow_data()?;
    require!(d.len() >= 101, SpikeError::BadFeed);
    let price = i64::from_le_bytes(d[73..81].try_into().unwrap());
    let publish = i64::from_le_bytes(d[93..101].try_into().unwrap());
    if price <= 0 || now - publish > 5 || publish - now > 5 {
        return Ok(None);
    }
    Ok(Some((((price + 500_000) / 1_000_000) as u32, publish)))
}

// -------------------------------------------------------------------- accounts

#[derive(Accounts)]
pub struct Init<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(init, payer = admin, space = 8 + Config::INIT_SPACE, seeds = [b"config"], bump)]
    pub config: Account<'info, Config>,
    #[account(init, payer = admin, space = 8 + Bank::INIT_SPACE, seeds = [b"bank"], bump)]
    pub bank: Account<'info, Bank>,
    #[account(init, payer = admin, space = 8 + House::INIT_SPACE, seeds = [b"house"], bump)]
    pub house: Account<'info, House>,
    #[account(init, payer = admin, space = 8 + Market::INIT_SPACE, seeds = [b"market"], bump)]
    pub market: Box<Account<'info, Market>>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminConfig<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [b"config"], bump, has_one = admin)]
    pub config: Account<'info, Config>,
}

#[derive(Accounts)]
pub struct AdminHouse<'info> {
    pub admin: Signer<'info>,
    #[account(seeds = [b"config"], bump, has_one = admin)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [b"house"], bump)]
    pub house: Account<'info, House>,
}

#[delegate]
#[derive(Accounts)]
pub struct DelegateHouse<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(seeds = [b"config"], bump, has_one = admin)]
    pub config: Account<'info, Config>,
    /// CHECK: pda
    #[account(mut, del, seeds = [b"house"], bump)]
    pub house: UncheckedAccount<'info>,
}

#[delegate]
#[derive(Accounts)]
pub struct DelegateMarket<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(seeds = [b"config"], bump, has_one = admin)]
    pub config: Account<'info, Config>,
    /// CHECK: pda
    #[account(mut, del, seeds = [b"market"], bump)]
    pub market: UncheckedAccount<'info>,
}

#[delegate]
#[derive(Accounts)]
pub struct OpenAccount<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub owner: Signer<'info>,
    #[account(seeds = [b"config"], bump)]
    pub config: Account<'info, Config>,
    #[account(init, payer = payer, space = 8 + Purse::INIT_SPACE, seeds = [b"purse", owner.key().as_ref()], bump)]
    pub purse: Account<'info, Purse>,
    /// CHECK: created and delegated here
    #[account(mut, del, seeds = [b"player", owner.key().as_ref()], bump)]
    pub player: UncheckedAccount<'info>,
}

#[delegate]
#[derive(Accounts)]
pub struct Redelegate<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: only seeds the PDA
    pub owner: UncheckedAccount<'info>,
    #[account(seeds = [b"config"], bump)]
    pub config: Account<'info, Config>,
    /// CHECK: pda
    #[account(mut, del, seeds = [b"player", owner.key().as_ref()], bump)]
    pub player: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct Buy<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut, seeds = [b"bank"], bump)]
    pub bank: Account<'info, Bank>,
    #[account(mut, seeds = [b"purse", owner.key().as_ref()], bump, has_one = owner)]
    pub purse: Account<'info, Purse>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SettlePayout<'info> {
    #[account(seeds = [b"config"], bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [b"bank"], bump)]
    pub bank: Account<'info, Bank>,
    #[account(mut, seeds = [b"purse", wallet.key().as_ref()], bump)]
    pub purse: Account<'info, Purse>,
    /// CHECK: must be the purse owner
    #[account(mut, address = purse.owner)]
    pub wallet: UncheckedAccount<'info>,
    /// CHECK: PDA of this program; owner (us or the delegation program) checked in the handler
    #[account(seeds = [b"player", wallet.key().as_ref()], bump)]
    pub player: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct SyncDeposit<'info> {
    #[account(mut, seeds = [b"player", player.authority.as_ref()], bump = player.bump)]
    pub player: Account<'info, Player>,
    #[account(seeds = [b"purse", player.authority.as_ref()], bump)]
    pub purse: Account<'info, Purse>,
}

#[commit]
#[derive(Accounts)]
pub struct CashOut<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(mut, seeds = [b"player", authority.key().as_ref()], bump = player.bump, has_one = authority)]
    pub player: Account<'info, Player>,
    /// CHECK: passed through to the L1 action
    #[account(seeds = [b"config"], bump)]
    pub config: UncheckedAccount<'info>,
    /// CHECK: passed through to the L1 action
    #[account(seeds = [b"bank"], bump)]
    pub bank: UncheckedAccount<'info>,
    /// CHECK: passed through to the L1 action
    #[account(seeds = [b"purse", authority.key().as_ref()], bump)]
    pub purse: UncheckedAccount<'info>,
    /// CHECK: the action's destination program
    #[account(address = crate::ID)]
    pub program_id: UncheckedAccount<'info>,
}

#[commit]
#[derive(Accounts)]
pub struct CommitOnly<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, seeds = [b"player", player.authority.as_ref()], bump = player.bump)]
    pub player: Account<'info, Player>,
}

#[vrf]
#[derive(Accounts, Session)]
pub struct Flip<'info> {
    #[account(mut)]
    pub signer: Signer<'info>,
    #[account(mut, seeds = [b"player", player.authority.as_ref()], bump = player.bump)]
    pub player: Account<'info, Player>,
    #[account(seeds = [b"purse", player.authority.as_ref()], bump)]
    pub purse: Account<'info, Purse>,
    #[account(mut, seeds = [b"house"], bump)]
    pub house: Account<'info, House>,
    #[session(signer = signer, authority = player.authority.key())]
    pub session_token: Option<Account<'info, SessionTokenV2>>,
    /// CHECK: the rollup's VRF queue
    #[account(mut, address = DEFAULT_EPHEMERAL_QUEUE)]
    pub oracle_queue: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct SettleFlip<'info> {
    /// Only the VRF program, answering a request from this program, can sign for this.
    #[account(address = VRF_IDENTITY)]
    pub vrf_program_identity: Signer<'info>,
    #[account(mut)]
    pub player: Account<'info, Player>,
    #[account(mut, seeds = [b"house"], bump)]
    pub house: Account<'info, House>,
}

#[derive(Accounts)]
pub struct Refund<'info> {
    #[account(mut, seeds = [b"player", player.authority.as_ref()], bump = player.bump)]
    pub player: Account<'info, Player>,
}

#[derive(Accounts)]
pub struct MarketAdmin<'info> {
    pub admin: Signer<'info>,
    #[account(seeds = [b"config"], bump, has_one = admin)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [b"market"], bump)]
    pub market: Box<Account<'info, Market>>,
}

#[derive(Accounts)]
pub struct CrankCreate<'info> {
    pub admin: Signer<'info>,
    #[account(seeds = [b"config"], bump, has_one = admin)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [b"house"], bump)]
    pub house: Account<'info, House>,
    /// CHECK: only its key is used
    #[account(seeds = [b"market"], bump)]
    pub market: UncheckedAccount<'info>,
    /// CHECK: Hydra derives and checks it
    #[account(mut)]
    pub crank: UncheckedAccount<'info>,
    /// CHECK: fixed address
    #[account(mut, address = EPH_VAULT)]
    pub eph_vault: UncheckedAccount<'info>,
    /// CHECK: fixed address
    #[account(address = MAGIC_PROGRAM)]
    pub magic_program: UncheckedAccount<'info>,
    /// CHECK: fixed address
    #[account(address = HYDRA_ER)]
    pub hydra: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct MarketTick<'info> {
    #[account(mut, seeds = [b"market"], bump)]
    pub market: Box<Account<'info, Market>>,
    #[account(seeds = [b"config"], bump)]
    pub config: Account<'info, Config>,
    /// CHECK: address pinned; owner and layout checked in fresh_price
    #[account(address = config.feed)]
    pub feed: UncheckedAccount<'info>,
    /// CHECK: instructions sysvar
    #[account(address = INSTRUCTIONS_SYSVAR)]
    pub instructions: UncheckedAccount<'info>,
    pub keeper: Option<Signer<'info>>,
}

// -------------------------------------------------------------------- state

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub admin: Pubkey,
    pub keeper: Pubkey,
    pub feed: Pubkey,
    pub validator: Pubkey,
    pub crank: Pubkey,
    pub fail_payout: bool,
}

#[account]
#[derive(InitSpace)]
pub struct Bank {
    pub reserved: u64,
}

#[account]
#[derive(InitSpace)]
pub struct Purse {
    pub owner: Pubkey,
    pub deposited: u64,
    pub paid_out: u64,
    pub payouts: u32,
}

#[account]
#[derive(InitSpace, Default)]
pub struct Player {
    pub authority: Pubkey,
    pub bump: u8,
    pub chips: u64,
    pub credited: u64,
    pub withdrawn: u64,
    pub seq: u64,
    pub pending: u64,
    pub pick: u8,
    pub last: u8,
    pub wins: u32,
    pub settled: u32,
    pub refunds: u32,
    pub placed_slot: u64,
    pub settled_slot: u64,
    pub synced_slot: u64,
    pub commits: u32,
    pub vrf: [u8; 32],
}

#[account]
#[derive(InitSpace)]
pub struct House {
    pub settled: u64,
    pub stale: u64,
    pub burn: u32,
    pub sink: u64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, InitSpace)]
pub struct Round {
    pub epoch: u32,
    pub lock_c: u32,
    pub close_c: u32,
    pub closed_ts: u32,
    pub late_s: u16,
    pub price_age_s: u16,
}

#[account]
#[derive(InitSpace)]
pub struct Market {
    pub enabled: bool,
    pub epoch: u64,
    pub open_lock_ts: i64,
    pub live_epoch: u64,
    pub live_lock_c: u32,
    pub calls: u64,
    pub last_call_ts: i64,
    pub max_gap_s: i64,
    pub closed: u64,
    pub voided: u64,
    pub by_crank: u64,
    pub by_keeper: u64,
    pub stale_price: u64,
    pub ring: [Round; RING],
}

#[error_code]
pub enum SpikeError {
    #[msg("bad amount")]
    BadAmount,
    #[msg("bad player account")]
    BadPlayer,
    #[msg("a bet is pending")]
    Busy,
    #[msg("forced failure")]
    ForcedFailure,
    #[msg("not allowed")]
    NotAllowed,
    #[msg("bad price feed")]
    BadFeed,
}
