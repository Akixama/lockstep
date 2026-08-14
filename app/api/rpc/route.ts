import { NextRequest, NextResponse } from "next/server";

const ALLOWED_METHODS = new Set(["getBalance", "getLatestBlockhash", "getSignatureStatuses", "getTransaction", "sendTransaction"]);
const RPC_URLS = [
  process.env.SOLANA_RPC_URL,
  "https://solana-rpc.publicnode.com",
  "https://api.mainnet-beta.solana.com",
].filter((url, index, urls): url is string => Boolean(url) && urls.indexOf(url) === index);

async function callRpc(url: string, method: string, params: unknown[]) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4_500);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: controller.signal,
    });
    const payload = await response.json() as { error?: unknown };
    if (!response.ok) throw new Error("RPC provider rejected the request");
    return payload;
  } finally {
    clearTimeout(timeout);
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as { method?: string; params?: unknown[] };
    if (!body.method || !ALLOWED_METHODS.has(body.method)) {
      return NextResponse.json({ error: "RPC method is not allowed" }, { status: 400 });
    }
    let rpcError: { error?: unknown } | null = null;
    for (const rpcUrl of RPC_URLS) {
      try {
        const payload = await callRpc(rpcUrl, body.method, body.params ?? []);
        if (payload.error) {
          rpcError ??= payload;
          continue;
        }
        return NextResponse.json(payload);
      } catch {
        // Public RPCs can rate-limit shared infrastructure, so try the next provider.
      }
    }
    if (rpcError) return NextResponse.json(rpcError, { status: 422 });
    return NextResponse.json({ error: "All Solana RPC providers are temporarily unavailable" }, { status: 502 });
  } catch {
    return NextResponse.json({ error: "Solana RPC request failed" }, { status: 502 });
  }
}
