# Hosting Lockstep

Lockstep is already configured for its current ChatGPT Sites deployment. The browser tab runs the scanner and trading engine, so it must stay open, unlocked, and connected to the internet while automation is active.

## Required before real trading

1. Use HTTPS in production.
2. Add `SOLANA_RPC_URL` as a private server-side environment variable. A dedicated Helius mainnet RPC endpoint is recommended because public Solana RPC providers can rate-limit trading traffic.
3. Do not add a wallet private key to hosting environment variables. Each wallet is created or imported in the browser and stored locally in encrypted form.
4. Deploy the always-running service from this repository's `relay/` directory on Railway (or another Docker host). Give it `PUMPPORTAL_API_KEY` and `LOCKSTEP_RELAY_SECRET` as private variables.
5. Add `PUMPPORTAL_RELAY_URL` and `PUMPPORTAL_RELAY_SECRET` to the website host. The secret must match `LOCKSTEP_RELAY_SECRET`. Keep `PUMPPORTAL_API_KEY` on the website only if you want its temporary in-process relay as a fallback.
6. Never expose any of these values with a `NEXT_PUBLIC_` prefix.
7. Keep the browser tab open and the wallet unlocked. Closing the tab or losing internet stops scanning and automated exits.

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
- The persistent relay keeps one authenticated PumpPortal WebSocket warm and shares it across visitors. HTTP price polling and the website's in-process relay remain fallbacks.
- No server-side wallet secret is needed.
- Test Migration Paper separately before enabling either real-SOL strategy.

## Persistent relay deployment

1. Create a service from the same GitHub repository and set its root directory to `relay`.
2. Generate a long random secret and add it as `LOCKSTEP_RELAY_SECRET`.
3. Add the funded PumpPortal data key as `PUMPPORTAL_API_KEY`.
4. After the host assigns a public HTTPS address, add that address to the website as `PUMPPORTAL_RELAY_URL` and add the same secret as `PUMPPORTAL_RELAY_SECRET`.
5. Redeploy the website. The relay's `/health` response should report `upstream: "connected"`.
