/**
 * Church campaigns (contract: campaigns.rs). The approval and claim texts must match the contract byte for byte.
 */
export const CAMPAIGN_KIND = { social: 0, project: 1, machine: 2 } as const;
export type CampaignKind = keyof typeof CAMPAIGN_KIND;
export interface NewCampaign {
  kind: number; title: string; url: string; machine_id: number; goal: number;
  reward_chips: number; reward_faith_milli: number; max_claims: number;
  /** how long it runs (Solana): 1 to 30 days */
  days?: number;
}
/** the least a campaign of each kind locks up for its rewards (Solana), in chips: social 0.5 SOL, project 1 SOL, machine 0.2 SOL */
export const CAMPAIGN_MIN_BUDGET = [500, 1_000, 200] as const;
/** what a campaign shows beyond the chain's fields: kept by our server, shown on its page */
export interface CampaignDetails { project: string; description: string; steps: string[]; banner?: string | null }
export const DETAIL_LIMITS = { project: 40, description: 400, steps: 5, step: 100, bannerBytes: 1_500_000 };
/** what the Church will print on a campaign's page; null = fine */
export function detailsProblem(d: CampaignDetails): string | null {
  const plain = (s: string) => /^[^<>]*$/.test(s) && !/https?:|www\./i.test(s);
  if (!d || typeof d.project !== 'string' || d.project.trim().length < 2 || d.project.length > DETAIL_LIMITS.project || !plain(d.project)) return 'Give the project a name (2 to 40 letters, no links).';
  if (typeof d.description !== 'string' || d.description.trim().length < 10 || d.description.length > DETAIL_LIMITS.description || !plain(d.description)) return 'Describe it in 10 to 400 characters, without links (the link has its own field).';
  if (!Array.isArray(d.steps) || d.steps.length > DETAIL_LIMITS.steps || d.steps.some((s) => typeof s !== 'string' || s.length > DETAIL_LIMITS.step || !plain(s))) return 'Up to 4 steps of 100 characters, without links.';
  if (RISKY.test(`${d.project} ${d.description} ${d.steps.join(' ')}`)) return 'The Church does not post scam wording (connect your wallet, seed phrases, airdrops, giveaways).';
  return null;
}
export const CAMPAIGN_LIMITS = { maxRewardChips: 50, maxRewardFaithMilli: 5_000, maxClaims: 500, minListingChips: 10, creatorMinFaith: 10, dailyFaithCap: 10 };

export function campaignApprovalMessage(creator: string, c: NewCampaign, expiresNs: string): string {
  return `cnc-campaign:${creator}:${c.kind}:${c.title}:${c.url}:${c.machine_id}:${c.goal}:${c.reward_chips}:${c.reward_faith_milli}:${c.max_claims}:${expiresNs}`;
}
export function campaignClaimMessage(id: number, player: string, expiresNs: string): string {
  return `cnc-claim:${id}:${player}:${expiresNs}`;
}
/** what a creator pays: the escrowed rewards plus the listing tithe (10%, at least 10 chips) */
export function campaignCost(c: Pick<NewCampaign, 'reward_chips' | 'max_claims'>): { budget: number; listing: number; total: number } {
  const budget = c.reward_chips * c.max_claims;
  const listing = Math.max(Math.floor(budget / 10), CAMPAIGN_LIMITS.minListingChips);
  return { budget, listing, total: budget + listing };
}

/** links a campaign may point at: well-known, read-only sites (no wallet-connect pages, no shorteners) */
const ALLOWED_HOSTS = ['x.com', 'twitter.com', 'github.com', 'solana.com', 'magicblock.xyz', 'magicblock.gg', 'colosseum.com', 'near.org', 'docs.near.org', 'near.ai', 'docs.near.ai', 'nearblocks.io',
  'testnet.nearblocks.io', 'medium.com', 'youtube.com', 'www.youtube.com', 'discord.gg', 't.me', 'mirror.xyz', 'dev.to', 'substack.com'];
/** scam wording: a wallet project is welcome, "connect your wallet" is not */
const RISKY = /(connect (your |a )?wallet|wallet.?connect|verify (your )?(wallet|account)|seed.?phrase|recovery.?phrase|private.?key|mnemonic|airdrop|giveaway|free.?(sol|near|nft|tokens?|crypto)|claim (your )?(tokens?|nft|airdrop|reward)|double your)/i;
/** in a link's path, more is suspicious */
const RISKY_URL = /(connect|wallet|claim|airdrop|seed|private.?key|mnemonic|verify.?account|bonus|giveaway|free.?near|free.?sol|login|signin)/i;

/** the Church's moderation rules (the oracle signs only campaigns that pass); null = fine */
export function campaignProblem(c: NewCampaign): string | null {
  const t = c.title;
  if (t.trim() !== t || t.length < 3 || t.length > 60) return 'The title must be 3 to 60 characters.';
  if (/https?:|www\.|\.[a-z]{2,}\//i.test(t)) return 'No links in the title; use the link field.';
  if (RISKY.test(t)) return 'The Church does not post scam wording (connect your wallet, seed phrases, airdrops, giveaways).';
  if (![0, 1, 2].includes(c.kind)) return 'Pick a campaign kind.';
  if (c.reward_chips < 0 || c.reward_chips > CAMPAIGN_LIMITS.maxRewardChips) return `Rewards are 0 to ${CAMPAIGN_LIMITS.maxRewardChips} chips per player.`;
  if (c.reward_faith_milli < 0 || c.reward_faith_milli > CAMPAIGN_LIMITS.maxRewardFaithMilli) return 'FAITH rewards are 0 to 5 per player.';
  if (c.reward_chips === 0 && c.reward_faith_milli === 0) return 'Offer chips, FAITH or both.';
  if (c.max_claims < 1 || c.max_claims > CAMPAIGN_LIMITS.maxClaims) return 'Between 1 and 500 players.';
  if (c.days !== undefined && (!Number.isInteger(c.days) || c.days < 1 || c.days > 30)) return 'A campaign runs 1 to 30 days.';
  if (c.kind === 2) {
    if (c.url !== '' || c.machine_id < 1 || c.goal < 1 || c.goal > 50) return 'A machine campaign needs your machine and 1 to 50 plays.';
    return null;
  }
  if (c.machine_id !== 0 || c.goal !== 0) return 'Only machine campaigns have a play goal.';
  let u: URL;
  try { u = new URL(c.url); } catch { return 'Enter a full https:// link.'; }
  if (u.protocol !== 'https:' || c.url.length > 160) return 'Links must start with https:// (160 characters at most).';
  const host = u.hostname.toLowerCase();
  if (!ALLOWED_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) return `The Church only links to well-known sites (${ALLOWED_HOSTS.slice(0, 6).join(', ')}, ...).`;
  if (RISKY_URL.test(u.pathname + u.search)) return 'That link looks like a wallet or airdrop page. The Church will not post it.';
  return null;
}
