import { NextRequest, NextResponse } from "next/server";

export async function GET(request: NextRequest) {
  const mint = request.nextUrl.searchParams.get("mint");
  if (!mint || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) return NextResponse.json({ error: "Invalid mint" }, { status: 400 });
  try {
    const response = await fetch(`https://frontend-api-v3.pump.fun/coins-v2/${encodeURIComponent(mint)}`, { cache: "no-store", headers: { accept: "application/json", "cache-control": "no-cache" } });
    if (!response.ok) return NextResponse.json({ error: `Pump.fun price request failed (${response.status})` }, { status: 502 });
    return NextResponse.json(await response.json(), { headers: { "cache-control": "no-store, no-cache, must-revalidate" } });
  } catch {
    return NextResponse.json({ error: "Pump.fun price request failed" }, { status: 502 });
  }
}
