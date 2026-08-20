# Hosting Lockstep

Lockstep is already configured for its current ChatGPT Sites deployment. The browser tab runs the scanner and trading engine, so it must stay open, unlocked, and connected to the internet while automation is active.

## Required before real trading

1. Use HTTPS in production.
2. Add `SOLANA_RPC_URL` as a private server-side environment variable. A dedicated Helius mainnet RPC endpoint is recommended because public Solana RPC providers can rate-limit trading traffic.
3. Do not add a wallet private key to hosting environment variables. Each wallet is created or imported in the browser and stored locally in encrypted form.
4. Add `PUMPPORTAL_API_KEY` as a private server-side environment variable. Lockstep uses it through a protected, rate-limited relay for metered per-token trades; never expose it with a `NEXT_PUBLIC_` prefix.
5. Keep the browser tab open and the wallet unlocked. Closing the tab or losing internet stops scanning and automated exits.

## Local check

Requirements: Node.js 22.13 or newer on Linux.

```bash
npm ci
cp .env.example .env.local
npm test
npm run dev
```

Replace the placeholder RPC key in `.env.local` before relying on real trading. Never commit `.env.local` or share it in the downloadable project.

## Production notes

- The app is a Vinext/Cloudflare Worker application, not a static HTML website. The host must run its server routes under `app/api/`.
- `SOLANA_RPC_URL` is optional for merely opening the dashboard because two public RPC fallbacks are built in, but it is strongly recommended for reliable real-SOL use.
- `SOL_USD_PRICE` is optional; live public price providers are tried first.
- `PUMPPORTAL_API_KEY` enables low-latency token-trade detection for every visitor while remaining server-only. HTTP price polling stays active as a fallback.
- No server-side wallet secret is needed.
- Test Migration Paper separately before enabling either real-SOL strategy.
