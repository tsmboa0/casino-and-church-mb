import { Component, useEffect, useRef, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { PrivyProvider, getAccessToken, getIdentityToken, useLogin, usePrivy } from '@privy-io/react-auth';
import { useCreateWallet, useSignTransaction, useWallets } from '@privy-io/react-auth/solana';
import { createSolanaRpc, createSolanaRpcSubscriptions } from '@solana/kit';
import { L1_RPC, PRIVY_APP_ID, type WalletBridge } from './index';

/** A crash inside Privy must never take the game down with it. */
class Boundary extends Component<{ children: ReactNode; onError: (e: Error) => void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(e: Error) { this.props.onError(e); }
  render() { return this.state.failed ? null : this.props.children; }
}

type Live = { authenticated: boolean; address: string | null };

function Island({ onReady }: { onReady: (b: WalletBridge) => void }) {
  const { ready, authenticated, logout } = usePrivy();
  const { wallets, ready: walletsReady } = useWallets();
  const { createWallet } = useCreateWallet();
  const { signTransaction } = useSignTransaction();
  const live = useRef<Live>({ authenticated: false, address: null });
  const waiter = useRef<((a: string | null) => void) | null>(null);
  const creating = useRef(false);
  const wallet = wallets[0];
  live.current = { authenticated, address: authenticated ? wallet?.address ?? null : null };
  const now = useRef({ wallet, signTransaction, logout, login: () => {} });

  const { login } = useLogin({ onError: () => { waiter.current?.(null); waiter.current = null; } });
  now.current = { wallet, signTransaction, logout, login: () => login() };

  // signed in and the wallet is there: whoever asked for a login gets the address
  useEffect(() => {
    if (authenticated && wallet) { waiter.current?.(wallet.address); waiter.current = null; }
  }, [authenticated, wallet]);
  // Privy's own form creates the wallet. This covers an account that somehow has none.
  useEffect(() => {
    if (!authenticated || !walletsReady || wallet || creating.current) return;
    const t = window.setTimeout(() => { creating.current = true; void createWallet().catch(() => {}).finally(() => { creating.current = false; }); }, 2500);
    return () => window.clearTimeout(t);
  }, [authenticated, walletsReady, wallet, createWallet]);

  useEffect(() => {
    if (!ready) return;
    const bridge: WalletBridge = {
      address: () => live.current.address,
      login: () => {
        if (live.current.address) return Promise.resolve(live.current.address);
        return new Promise((res) => { waiter.current = res; if (!live.current.authenticated) now.current.login(); });
      },
      logout: () => now.current.logout(),
      signTransaction: async (transaction) => {
        if (!now.current.wallet) throw new Error('Sign in first.');
        return (await now.current.signTransaction({ transaction, wallet: now.current.wallet, chain: 'solana:devnet' })).signedTransaction;
      },
      accessToken: () => getAccessToken(),
      identityToken: () => getIdentityToken(),
    };
    // a restored session needs a moment for its wallet to appear, so CONTINUE can show straight away
    const t0 = Date.now();
    const t = window.setInterval(() => {
      if (!live.current.authenticated || live.current.address || Date.now() - t0 > 4000) { window.clearInterval(t); onReady(bridge); }
    }, 60);
    return () => window.clearInterval(t);
  }, [ready]);
  return null;
}

export function mountWallet(): Promise<WalletBridge> {
  return new Promise((res, rej) => {
    const host = document.createElement('div'); host.id = 'wallet-root'; document.body.appendChild(host);
    const timer = window.setTimeout(() => rej(new Error('Sign-in is taking too long to load. Check your connection.')), 25_000);
    const fail = (e: Error) => { console.error('wallet', e); rej(e); };
    createRoot(host).render(
      <Boundary onError={fail}>
        <PrivyProvider
          appId={PRIVY_APP_ID}
          config={{
            loginMethods: ['email'],
            appearance: { theme: '#14101c', accentColor: '#f5c542', landingHeader: 'The Casino & The Church', loginMessage: 'Sign in to play. Devnet, play money.' },
            embeddedWallets: { solana: { createOnLogin: 'users-without-wallets' }, ethereum: { createOnLogin: 'off' } },
            // Privy's confirmation popup needs an RPC for the chain, or it crashes ("No RPC configuration found")
            solana: { rpcs: { 'solana:devnet': { rpc: createSolanaRpc(L1_RPC), rpcSubscriptions: createSolanaRpcSubscriptions(L1_RPC.replace(/^http/, 'ws')) } } },
          }}
        >
          <Island onReady={(b) => { window.clearTimeout(timer); res(b); }} />
        </PrivyProvider>
      </Boundary>,
    );
  });
}
