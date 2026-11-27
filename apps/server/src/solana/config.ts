import { existsSync, readFileSync } from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { b58decode, signerFrom, type Signer } from '@cnc/realm';

// local secrets (gitignored): KEY=value lines, never printed
for (const f of [new URL('../../.env.local', import.meta.url).pathname]) if (existsSync(f)) for (const l of readFileSync(f, 'utf8').split('\n')) { const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(l.trim()); if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"|"$/g, ''); }
const env = process.env;
/** a key from the environment (base58 or a JSON array). On a development machine: ~/.config/casino-mb/devnet/<file>.json */
function key(name: string, file: string): Signer | null {
  const v = env[name]?.trim();
  if (v) return signerFrom(v.startsWith('[') ? Uint8Array.from(JSON.parse(v)) : b58decode(v));
  const f = path.join(os.homedir(), '.config/casino-mb/devnet', `${file}.json`);
  return env.NODE_ENV !== 'production' && existsSync(f) ? signerFrom(Uint8Array.from(JSON.parse(readFileSync(f, 'utf8')))) : null;
}
export const config = {
  port: Number(env.PORT ?? 8787),
  l1: env.L1_RPC_URL ?? 'https://rpc.magicblock.app/devnet',
  er: env.ER_RPC_URL ?? 'https://devnet-eu.magicblock.app',
  origins: (env.CLIENT_ORIGIN ?? 'http://localhost:5173').split(',').map((s) => s.trim()),
  /** both public: they only let us CHECK Privy's tokens */
  privyAppId: env.PRIVY_APP_ID ?? 'cmwuvir3900yw0gjg70uacpq8',
  privyKey: (env.PRIVY_VERIFICATION_KEY ?? '-----BEGIN PUBLIC KEY-----\nMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEqsFE40+g5Tte/euEoVPR7y5d5FHNbcSKg9vxZSs8dmtFJY8vEDf50hNE9lOke4btX5cEoEhzSI2/cBaZ7izQKg==\n-----END PUBLIC KEY-----').replace(/\\n/g, '\n'),
  sponsor: key('SPONSOR_KEY', 'sponsor'),
  keeper: key('KEEPER_KEY', 'keeper'),
  /** delegated to the rollup: pays the market's saves to L1 past MagicBlock's free ten */
  feePayer: key('FEEPAYER_KEY', 'feepayer'),
  /** the Church oracle: co-signs campaigns it has read, and claims it has seen */
  oracle: key('ORACLE_KEY', 'oracle'),
  /** the AI hosts' keys: each writes its decisions on L1 and acts on the rollup */
  fortuna: key('FORTUNA_KEY', 'fortuna'),
  nakamoto: key('NAKAMOTO_KEY', 'nakamoto'),
  hosts: { nearaiKey: env.NEARAI_API_KEY ?? '', nearaiBase: (env.NEARAI_BASE_URL || 'https://cloud-api.near.ai/v1').replace(/\/$/, ''), nearaiModel: env.NEARAI_MODEL || 'Qwen/Qwen3.8-27B', nearaiDailyTokens: Number(env.NEARAI_DAILY_TOKEN_CAP ?? 150_000), chatShare: Number(env.NEARAI_CHAT_SHARE ?? 0.6), everyMin: Number(env.AGENT_EVERY_MIN ?? 10), askPerWalletHour: Number(env.ASK_PER_ACCOUNT_HOUR ?? 10), askPerIpHour: Number(env.ASK_PER_IP_HOUR ?? 60), disabled: env.AGENTS_DISABLED === '1' },
  databaseUrl: env.DATABASE_URL ?? '',
  faucetLamports: BigInt(env.FAUCET_LAMPORTS ?? 50_000_000),        // 0.05 SOL
  accountsTotal: Number(env.ACCOUNTS_TOTAL ?? 3000),
  accountsPerIpDay: Number(env.ACCOUNTS_PER_IP_DAY ?? 40),          // a venue shares one Wi-Fi address
  faucetPerIpDay: Number(env.FAUCET_PER_IP_DAY ?? 40),
  sessionDays: 6,
};
export type Config = typeof config;
/** the faucet stops first, then new accounts: existing players never depend on either */
export const FAUCET_FLOOR = 1_000_000_000n, SETUP_FLOOR = 300_000_000n;
