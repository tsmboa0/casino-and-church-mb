/**
 * The player's main wallet: Privy (email login, an embedded Solana wallet).
 * The game never sees React. It talks to this bridge; the Privy island is loaded lazily behind the title screen.
 */
export interface WalletBridge {
  /** the wallet address when signed in, else null */
  address(): string | null;
  /** opens Privy's login over whatever is on screen; resolves with the address, or null if the player closed it */
  login(): Promise<string | null>;
  logout(): Promise<void>;
  /** shows Privy's confirmation popup and returns the signed bytes. We send them ourselves (L1 or the rollup). */
  signTransaction(tx: Uint8Array): Promise<Uint8Array>;
  accessToken(): Promise<string | null>;
  identityToken(): Promise<string | null>;
}

const env = import.meta.env as unknown as Record<string, string | undefined>;
/** public by design: it only names the app. The app secret is never used here. */
export const PRIVY_APP_ID = env.VITE_PRIVY_APP_ID ?? 'cmwuvir3900yw0gjg70uacpq8';
export const L1_RPC = env.VITE_L1_RPC ?? 'https://rpc.magicblock.app/devnet';
export const ER_RPC = env.VITE_ER_RPC ?? 'https://devnet-eu.magicblock.app';

/** real accounts, except in the offline demo (?demo=1) and for automated testers of the demo (?agent=1 with no server) */
export const walletEnabled = !!PRIVY_APP_ID && new URLSearchParams(location.search).get('demo') !== '1';

let loading: Promise<WalletBridge> | null = null;
/** loads Privy once (about 300 KB gzipped) and restores a previous session */
export function loadWallet(): Promise<WalletBridge> {
  // development builds only (removed from production): lets an automated test stand in for Privy
  if (import.meta.env.DEV && (window as any).__testWallet) return Promise.resolve((window as any).__testWallet as WalletBridge);
  loading ??= import('./island').then((m) => m.mountWallet()).catch((e) => { loading = null; throw e; });
  return loading;
}

export const shortAddress = (a: string) => `${a.slice(0, 4)}...${a.slice(-4)}`;
