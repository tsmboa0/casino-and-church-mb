# Deploy

Solana **devnet** and the MagicBlock EU devnet rollup. Never point any of this at mainnet.

## What runs where

| Part | Where | Notes |
|---|---|---|
| Program `realm` | Solana devnet, `6uoz1h2ZWQMgniDx2vKEvh6bHtgCoFoGegfVtNW1q6cX` | Shared accounts delegated to `https://devnet-eu.magicblock.app` |
| Server | Railway, project `casino-and-church-mb`, service `server`, with Postgres | `railway.json`; `pnpm start` runs `apps/server/src/solana/index.ts` |
| Client | Vercel, project `casino-and-church-mb` | Built locally (the licensed art is not in git), then deployed as static files |

## Toolchain

- Node 22+ and pnpm 10.
- Rust 1.89 and Anchor 1.0.2 (`RUSTUP_TOOLCHAIN=1.89.0`). Build with `anchor build --no-idl --ignore-keys`, then delete
  `target/deploy/realm-keypair.json` and check the binary contains the program id. Regenerate the IDL with
  `anchor idl build -p realm -o target/idl/realm.json` and `node packages/realm/scripts/idl.mjs`.
- Solana CLI for deploys and transfers.

## Keys

Local keys live in `~/.config/casino-mb/devnet/` (never in git): `admin` (program upgrade authority and config),
`sponsor` (pays player set-up and the faucet), `keeper` (market backup, cash-outs, refunds; the key the program knows
as the market's keeper), `oracle` (the Church oracle's co-signature), `fortuna` and `nakamoto` (the AI hosts).

On Railway, each is a variable holding the key as a JSON array: `SPONSOR_KEY`, `KEEPER_KEY`, `ORACLE_KEY`,
`FORTUNA_KEY`, `NAKAMOTO_KEY`. Set them from the files so they never pass through a terminal or a chat:

```bash
K=~/.config/casino-mb/devnet
railway variables --service server --skip-deploys --set "SPONSOR_KEY=$(tr -d '\n ' < $K/sponsor.json)"   # and so on
```

## Server variables

| Variable | |
|---|---|
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` (Railway reference) |
| `CLIENT_ORIGIN` | the site, comma-separated with any others (CORS) |
| `NEARAI_API_KEY`, `NEARAI_MODEL`, `NEARAI_DAILY_TOKEN_CAP` | the AI hosts |
| `ADMIN_TOKEN` | at least 24 characters; for taking a campaign down (`scripts/solana/takedown.ts`) |
| `TRUST_PROXY_HOPS` | `1` on Railway: the client IP is the one Railway's proxy saw |
| `ALERT_WEBHOOK` | optional Discord or Slack webhook: the server posts when `/healthz` alerts start or clear |
| `HOSTS=0`, `MARKET_KEEPER=0` | switch those parts off (for a second instance) |
| `REQS_PER_MIN`, `POSTS_PER_MIN` | the per-network request ceiling (2,400 and 240) |

Run **one** server per program. A second one would run the keepers and the hosts twice.

## Deploying

```bash
# server
railway up --service server --detach

# client
cd apps/client && VITE_API_URL=https://server-production-41bf466c.up.railway.app npx vite build --outDir ../../spike/target/site --emptyOutDir
# the build empties the folder: put vercel.json and .vercelignore back, then
cd ../../spike/target/site && npx vercel link --yes --project casino-and-church-mb && npx vercel deploy --prod --yes
```

The site folder also holds a `vercel.json` (security headers) and a `.vercelignore` (`.env.local`, `.vercel`).
After a new site domain, add it to `CLIENT_ORIGIN` on Railway and to the allowed domains in the Privy dashboard.

## A fresh program (first time only)

`scripts/solana/init.ts` sets up the config, bank, house, market, plots and boards, funds the pools, delegates the
shared accounts and starts the market and its crank (safe to run again). `scripts/solana/church.ts` seeds the Church's
campaigns.

## Upgrading the program

Pause, upgrade, check, unpause. Never change the layout of a delegated account except through its spare bytes.
Deploy through a buffer:

```bash
solana program deploy target/deploy/realm.so --buffer ~/.config/casino-mb/devnet/realm-buffer.json \
  --program-id ~/.config/casino-mb/devnet/realm-program.json --upgrade-authority ~/.config/casino-mb/devnet/admin.json \
  -u https://rpc.magicblock.app/devnet --use-rpc --with-compute-unit-price 20000 --max-sign-attempts 30
```

## Launch checks

- `GET /healthz`: `ok: true`, `alerts: []` (the sponsor needs at least 2 SOL).
- `scripts/solana/e2e.ts` twice: 35 checks each.
- `scripts/solana/load.ts`: 30 players at once.
- `scripts/ui/prod.ts`: the live site and API from outside.
- After any test run, `scripts/solana/sweep.ts` brings the test wallets' SOL home.
