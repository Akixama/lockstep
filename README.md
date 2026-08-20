# Lockstep

Browser-based Solana execution console for pump.fun / PumpSwap migration trading. Runs client-side — trading keypairs are generated or imported in the browser, encrypted locally, and never leave the device.

## What it does

- **Migration (BOOST) mode** — watches pump.fun launches, waits for a token to migrate to PumpSwap, and buys once it lands inside a configured market-cap window after migration.
- **Exit handling** — takes profit at a target %, sells off in timed slices, or force-exits ~5 minutes after the migration window opened.
- **New Pairs mode** — a separate live strategy for trading freshly launched bonding-curve tokens directly.
- **Paper mode** — same logic and live market data, but never signs or sends a transaction. Useful for testing settings risk-free.

## Stack

- Next.js 16 / React 19, built with Cloudflare's [`vinext`](https://github.com/cloudflare/vinext) framework (Netlify deploy also configured — see `netlify.toml`)
- Trade construction via PumpPortal's `trade-local` API (`app/api/trade`); the returned transaction is signed client-side with the local wallet and submitted through the app's own RPC proxy (`app/api/rpc`)
- Metered PumpPortal token trades pass through a server-only SSE relay with per-IP, per-token, and global limits; the funded API key is never sent to browsers
- Drizzle + Cloudflare D1 are wired into the project scaffold but currently unused (`db/schema.ts` is empty)

## Running locally

```bash
npm run install:ci
npm run dev
```

## ⚠️ Live money

Outside of Paper mode, this signs and submits real mainnet transactions with real SOL. Losses are possible from slippage, failed transactions, and the underlying token. Test in Paper mode before running live.

## Deploy

```bash
npm run build
npm start
```

Netlify auto-deploys from `main` if the site is linked in the Netlify dashboard.
