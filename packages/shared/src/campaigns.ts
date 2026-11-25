/**
 * Church campaigns (contract: campaigns.rs). The approval and claim texts must match the contract byte for byte.
 */
export const CAMPAIGN_KIND = { social: 0, project: 1, machine: 2 } as const;
export type CampaignKind = keyof typeof CAMPAIGN_KIND;
export interface NewCampaign {
  kind: number; title: string; url: string; machine_id: number; goal: number;
  reward_chips: number; reward_faith_milli: number; max_claims: number;
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
const RISKY = /(connect|wallet|claim|airdrop|seed|private.?key|mnemonic|verify.?account|bonus|giveaway|free.?near|login|signin)/i;

/** the Church's moderation rules (the oracle signs only campaigns that pass); null = fine */
export function campaignProblem(c: NewCampaign): string | null {
  const t = c.title;
  if (t.trim() !== t || t.length < 3 || t.length > 60) return 'The title must be 3 to 60 characters.';
  if (/https?:|www\.|\.[a-z]{2,}\//i.test(t)) return 'No links in the title; use the link field.';
  if (RISKY.test(t)) return 'The Church does not post wallet, airdrop or giveaway campaigns.';
  if (![0, 1, 2].includes(c.kind)) return 'Pick a campaign kind.';
  if (c.reward_chips < 0 || c.reward_chips > CAMPAIGN_LIMITS.maxRewardChips) return `Rewards are 0 to ${CAMPAIGN_LIMITS.maxRewardChips} chips per player.`;
  if (c.reward_faith_milli < 0 || c.reward_faith_milli > CAMPAIGN_LIMITS.maxRewardFaithMilli) return 'FAITH rewards are 0 to 5 per player.';
  if (c.reward_chips === 0 && c.reward_faith_milli === 0) return 'Offer chips, FAITH or both.';
  if (c.max_claims < 1 || c.max_claims > CAMPAIGN_LIMITS.maxClaims) return 'Between 1 and 500 players.';
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
  if (RISKY.test(u.pathname + u.search)) return 'That link looks like a wallet or airdrop page. The Church will not post it.';
  return null;
}
