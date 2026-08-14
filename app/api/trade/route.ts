import { NextRequest, NextResponse } from "next/server";

const TRADE_URL = "https://pumpportal.fun/api/trade-local";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as Record<string, unknown>;
    if (body.action !== "buy" && body.action !== "sell") return NextResponse.json({ error: "Invalid trade action" }, { status: 400 });
    if (typeof body.publicKey !== "string" || typeof body.mint !== "string") return NextResponse.json({ error: "Wallet and mint are required" }, { status: 400 });
    const response = await fetch(TRADE_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (!response.ok) return NextResponse.json({ error: `Trade builder rejected the order: ${(await response.text()).slice(0, 180)}` }, { status: 502 });
    const transaction = Buffer.from(await response.arrayBuffer()).toString("base64");
    return NextResponse.json({ transaction });
  } catch {
    return NextResponse.json({ error: "Could not build trade transaction" }, { status: 502 });
  }
}
