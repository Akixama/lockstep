import { NextResponse } from "next/server";

const headers = { "cache-control": "public, max-age=30, s-maxage=60, stale-while-revalidate=300" };
const LAST_KNOWN_SOL_USD = 75.89;

async function coinbasePrice() {
  const response = await fetch("https://api.coinbase.com/v2/prices/SOL-USD/spot", { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error("Coinbase price unavailable");
  const payload = await response.json() as { data?: { amount?: string } };
  return Number(payload.data?.amount);
}

async function krakenPrice() {
  const response = await fetch("https://api.kraken.com/0/public/Ticker?pair=SOLUSD", { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error("Kraken price unavailable");
  const payload = await response.json() as { result?: Record<string, { c?: string[] }> };
  const ticker = Object.values(payload.result ?? {})[0];
  return Number(ticker?.c?.[0]);
}

async function coinGeckoPrice() {
  const response = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd", { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error("CoinGecko price unavailable");
  const payload = await response.json() as { solana?: { usd?: number } };
  return Number(payload.solana?.usd);
}

export async function GET() {
  for (const [source, getPrice] of [["coinbase", coinbasePrice], ["kraken", krakenPrice], ["coingecko", coinGeckoPrice]] as const) {
    try {
      const price = await getPrice();
      if (Number.isFinite(price) && price > 0) return NextResponse.json({ price, source }, { headers });
    } catch { /* try the next provider */ }
  }

  const configuredPrice = Number(process.env.SOL_USD_PRICE);
  const price = Number.isFinite(configuredPrice) && configuredPrice > 0 ? configuredPrice : LAST_KNOWN_SOL_USD;
  return NextResponse.json({ price, source: "last-known", fallback: true }, { headers });
}
