import { NextRequest, NextResponse } from "next/server";

const ALLOWED_METHODS = new Set([
  "getBalance",
  "getLatestBlockhash",
  "getMultipleAccounts",
  "getSignatureStatuses",
  "getTransaction",
  "sendTransaction",
  "getRecentPrioritizationFees",
  "simulateTransaction",
]);

const RPC_URLS = [
  process.env.SOLANA_RPC_URL,
  "https://solana-rpc.publicnode.com",
  "https://api.mainnet-beta.solana.com",
].filter((url, index, urls): url is string => Boolean(url) && urls.indexOf(url) === index);

type RpcId = string | number | null;
type RpcPayload = { jsonrpc?: string; id?: RpcId; result?: unknown; error?: unknown };

class RpcPayloadError extends Error {
  payload: RpcPayload;

  constructor(payload: RpcPayload) {
    super("RPC returned an error");
    this.payload = payload;
  }
}

function rpcRouteLabel(url: string) {
  try { return new URL(url).hostname; } catch { return "solana-rpc"; }
}

async function callRpc(url: string, method: string, params: unknown[], requestId: RpcId) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4_500);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // @solana/web3.js uses a string request id and validates that the
      // response echoes it. Replacing it with numeric `1` made otherwise
      // valid getMultipleAccounts responses fail client-side validation,
      // which silently forced PumpSwap buys onto the slower remote builder.
      body: JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }),
      signal: controller.signal,
    });
    const payload = await response.json() as RpcPayload;
    if (!response.ok) throw new Error("RPC provider rejected the request");
    return payload;
  } finally {
    clearTimeout(timeout);
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as { id?: RpcId; method?: string; params?: unknown[] };
    if (!body.method || !ALLOWED_METHODS.has(body.method)) {
      return NextResponse.json({ error: "RPC method is not allowed" }, { status: 400 });
    }
    // Broadcasting the exact same signed bytes cannot create duplicate buys:
    // every provider derives the same Solana signature and the network accepts
    // that signature only once. Starting all submissions together removes a
    // slow-provider waterfall from the latency-critical landing path.
    if (body.method === "sendTransaction") {
      const submissions = RPC_URLS.map(async (rpcUrl) => {
        const payload = await callRpc(rpcUrl, body.method!, body.params ?? [], body.id ?? 1);
        if (payload.error) throw new RpcPayloadError(payload);
        return { payload, route: rpcRouteLabel(rpcUrl) };
      });
      try {
        const accepted = await Promise.any(submissions);
        return NextResponse.json({
          ...accepted.payload,
          lockstep: { routesAttempted: RPC_URLS.length, acceptedBy: accepted.route },
        });
      } catch (caught) {
        const errors = caught instanceof AggregateError ? caught.errors : [caught];
        const rpcFailure = errors.find((error) => error instanceof RpcPayloadError) as RpcPayloadError | undefined;
        if (rpcFailure) return NextResponse.json({ ...rpcFailure.payload, lockstep: { routesAttempted: RPC_URLS.length } }, { status: 422 });
        return NextResponse.json({ error: "All Solana transaction routes are temporarily unavailable", lockstep: { routesAttempted: RPC_URLS.length } }, { status: 502 });
      }
    }

    let rpcError: RpcPayload | null = null;
    for (const rpcUrl of RPC_URLS) {
      try {
        const payload = await callRpc(rpcUrl, body.method, body.params ?? [], body.id ?? 1);
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
