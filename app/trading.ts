"use client";

import { Keypair, VersionedTransaction } from "@solana/web3.js";

export type LaunchCandidate = {
  mint: string;
  symbol: string;
  name: string;
  priceSol: number;
  marketCapSol: number;
  marketCapUsd?: number;
  virtualSolReserves?: number;
  virtualTokenReserves?: number;
  migrationSignature?: string;
  detectedAt?: number;
  isMayhemMode?: boolean;
  boostMode?: string;
  isStandardPumpfunMigration?: boolean;
};

export type MigrationVerification = {
  candidate: LaunchCandidate;
  ageSeconds: number;
};

export type LivePosition = {
  id: string;
  mint: string;
  symbol: string;
  name?: string;
  entryPriceSol: number;
  currentPriceSol: number;
  highPriceSol: number;
  entryMarketCapSol?: number;
  currentMarketCapSol?: number;
  entryMarketCapUsd?: number;
  currentMarketCapUsd?: number;
  amountSol: number;
  remainingPercent: number;
  openedAt: number;
  buySignature: string;
  status: "open" | "closing";
  execution?: "live" | "paper";
  source?: "new-token" | "migration";
  actualCostSol?: number;
  paperInitialTokenValueSol?: number;
  paperExitPlan?: {
    slicePercent: number;
    intervalSeconds: number;
    slicesCompleted: number;
    nextSliceAt: number;
    expiresAt?: number;
  };
  migrationExitPlan?: {
    slicePercent: number;
    intervalSeconds: number;
    slicesCompleted: number;
    nextSliceAt: number;
    expiresAt: number;
  };
};

export type LiveBuyQuote = {
  amountSol: number;
  impactPercent: number;
  estimatedTokensOut: number;
  quotedAt: number;
};

export type PaperBuyBuild = { transactionBytes: number };

export type TokenTradeWatcher = (mint: string, onTrade: (mark: LaunchCandidate) => void) => () => void;

const LAMPORTS_PER_SOL = 1_000_000_000;
const TOTAL_BONDING_CURVE_FEE_BPS = 125n;
const PROTOCOL_FEE_BPS = 95n;
const CREATOR_FEE_BPS = 30n;

function ceilDiv(value: bigint, divisor: bigint) {
  return (value + divisor - 1n) / divisor;
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  bytes.forEach((byte) => (binary += String.fromCharCode(byte)));
  return btoa(binary);
}

function base64ToBytes(value: string) {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

async function rpc(method: string, params: unknown[]) {
  const response = await fetch("/api/rpc", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ method, params }),
  });
  const payload = await response.json();
  if (!response.ok || payload.error) throw new Error(payload.error?.message ?? payload.error ?? `${method} failed`);
  return payload.result;
}

export async function buildSignAndSendTrade({ keypair, action, mint, amount, slippagePercent, pool }: { keypair: Keypair; action: "buy" | "sell"; mint: string; amount: number | string; slippagePercent: number; pool?: "auto" | "pump" | "pump-amm" }) {
  const response = await fetch("/api/trade", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      publicKey: keypair.publicKey.toBase58(),
      action,
      mint,
      amount,
      denominatedInSol: action === "buy" ? "true" : "false",
      slippage: slippagePercent,
      priorityFee: 0.0005,
      pool: pool ?? "auto",
    }),
  });
  const payload = await response.json();
  if (!response.ok || !payload.transaction) throw new Error(payload.error ?? "Could not build transaction");
  const transaction = VersionedTransaction.deserialize(base64ToBytes(payload.transaction));
  transaction.sign([keypair]);
  // Fresh Pump.fun accounts can reach the leader before shared RPC simulation nodes.
  // Submit the signed transaction directly, then verify confirmation below.
  const signature = await rpc("sendTransaction", [bytesToBase64(transaction.serialize()), { encoding: "base64", skipPreflight: true, maxRetries: 3 }]) as string;
  await waitForConfirmation(signature);
  return signature;
}

export async function buildExactPaperBuy({ publicKey, mint, amountSol, slippagePercent }: { publicKey: string; mint: string; amountSol: number; slippagePercent: number }): Promise<PaperBuyBuild> {
  if (!Number.isFinite(amountSol) || amountSol <= 0) throw new Error("Simulation amount is invalid");
  const response = await fetch("/api/trade", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      publicKey,
      action: "buy",
      mint,
      amount: amountSol,
      denominatedInSol: "true",
      slippage: slippagePercent,
      priorityFee: 0.0005,
      pool: "auto",
    }),
  });
  const payload = await response.json();
  if (!response.ok || !payload.transaction) throw new Error(payload.error ?? "Could not build the exact order");
  const transactionBytes = base64ToBytes(payload.transaction);
  if (transactionBytes.byteLength < 100) throw new Error("The live trade builder returned an invalid transaction");
  return { transactionBytes: transactionBytes.byteLength };
}

async function waitForConfirmation(signature: string) {
  for (let attempt = 0; attempt < 28; attempt++) {
    const result = await rpc("getSignatureStatuses", [[signature], { searchTransactionHistory: true }]) as { value?: Array<{ confirmationStatus?: string; err?: unknown } | null> };
    const status = result.value?.[0];
    if (status?.err) throw new Error(`Transaction failed: ${JSON.stringify(status.err)}`);
    if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") return;
    await new Promise((resolve) => setTimeout(resolve, 750));
  }
  throw new Error(`Transaction confirmation timed out: ${signature}`);
}

export async function fetchPumpPrice(mint: string) {
  const response = await fetch(`/api/price?mint=${encodeURIComponent(mint)}`, { cache: "no-store" });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error ?? "Price unavailable");
  const coin = payload.data && typeof payload.data === "object" ? payload.data : payload;
  const virtualQuoteReservesRaw = String(coin.virtual_quote_reserves ?? coin.virtual_sol_reserves ?? "");
  const virtualTokenReservesRaw = String(coin.virtual_token_reserves ?? "");
  const solReserve = Number(virtualQuoteReservesRaw) / 1_000_000_000;
  const tokenReserve = Number(coin.virtual_token_reserves) / 1_000_000;
  const supply = Number(coin.total_supply || 1_000_000_000_000_000) / 1_000_000;
  const reportedMarketCapSol = Number(coin.market_cap ?? coin.market_cap_quote);
  const reportedMarketCapUsd = Number(coin.usd_market_cap ?? coin.market_cap_usd);
  const poolAddress = [coin.pool_address, coin.raydium_pool, coin.pump_swap_pool, coin.pumpswap_pool]
    .find((value) => typeof value === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)) as string | undefined;
  const boostMode = typeof coin.boost_mode === "string"
    ? coin.boost_mode.trim().toUpperCase()
    : typeof coin.boostMode === "string"
      ? coin.boostMode.trim().toUpperCase()
      : "";
  const isMayhemMode = coin.is_mayhem_mode === true
    || coin.isMayhemMode === true
    || boostMode.includes("MAYHEM");
  // Pump.fun can keep a completed, pooled migration at IN_PROGRESS while it is
  // already tradable. Treat NONE as confirmed-standard and IN_PROGRESS as
  // provisionally standard; an affirmative Mayhem signal always wins.
  const isStandardPumpfunMigration = !isMayhemMode && (boostMode === "NONE" || boostMode === "IN_PROGRESS");
  const reservePriceSol = solReserve / tokenReserve;
  const priceSol = Number.isFinite(reportedMarketCapSol) && reportedMarketCapSol > 0
    ? reportedMarketCapSol / supply
    : reservePriceSol;
  if (!Number.isFinite(priceSol) || priceSol <= 0) throw new Error("Price response was invalid");
  return {
    priceSol,
    marketCapSol: Number.isFinite(reportedMarketCapSol) && reportedMarketCapSol > 0 ? reportedMarketCapSol : priceSol * supply,
    marketCapUsd: Number.isFinite(reportedMarketCapUsd) && reportedMarketCapUsd > 0 ? reportedMarketCapUsd : undefined,
    symbol: typeof coin.symbol === "string" && coin.symbol.trim() ? coin.symbol.trim() : undefined,
    name: typeof coin.name === "string" && coin.name.trim() ? coin.name.trim() : undefined,
    complete: coin.complete === true,
    isMayhemMode,
    boostMode,
    isStandardPumpfunMigration,
    poolAddress,
    virtualQuoteReservesRaw,
    virtualTokenReservesRaw,
    quotedAt: Date.now(),
  };
}

export async function fetchLiveBuyQuote(candidate: LaunchCandidate, amountSol: number): Promise<LiveBuyQuote> {
  if (!Number.isFinite(amountSol) || amountSol <= 0) throw new Error("Quote amount is invalid");
  // PumpPortal's creation event contains the live bonding-curve reserves before
  // Pump.fun's metadata API has necessarily indexed the mint. Use those realtime
  // reserves first so a brand-new token is not incorrectly skipped on a metadata
  // 404. The metadata route remains a fallback for older feed frames.
  let virtualQuoteReserves = 0n;
  let virtualTokenReserves = 0n;
  let quotedAt = Date.now();
  if (Number.isFinite(candidate.virtualSolReserves) && Number(candidate.virtualSolReserves) > 0
    && Number.isFinite(candidate.virtualTokenReserves) && Number(candidate.virtualTokenReserves) > 0) {
    virtualQuoteReserves = BigInt(Math.round(Number(candidate.virtualSolReserves) * LAMPORTS_PER_SOL));
    virtualTokenReserves = BigInt(Math.round(Number(candidate.virtualTokenReserves) * 1_000_000));
  } else {
    const mark = await fetchPumpPrice(candidate.mint);
    if (mark.complete) throw new Error("Token has already migrated; new-pair entry skipped");
    try {
      virtualQuoteReserves = BigInt(mark.virtualQuoteReservesRaw);
      virtualTokenReserves = BigInt(mark.virtualTokenReservesRaw);
      quotedAt = mark.quotedAt;
    } catch {
      throw new Error("Fresh bonding-curve reserves were unavailable");
    }
  }
  if (virtualQuoteReserves <= 0n || virtualTokenReserves <= 0n) throw new Error("Fresh bonding-curve reserves were unavailable");

  const spendableQuoteIn = BigInt(Math.round(amountSol * LAMPORTS_PER_SOL));
  let netQuote = spendableQuoteIn * 10_000n / (10_000n + TOTAL_BONDING_CURVE_FEE_BPS);
  const fees = ceilDiv(netQuote * PROTOCOL_FEE_BPS, 10_000n) + ceilDiv(netQuote * CREATOR_FEE_BPS, 10_000n);
  if (netQuote + fees > spendableQuoteIn) netQuote -= netQuote + fees - spendableQuoteIn;
  if (netQuote <= 1n) throw new Error("Quote amount is too small");
  const estimatedTokensOutRaw = (netQuote - 1n) * virtualTokenReserves / (virtualQuoteReserves + netQuote - 1n);
  if (estimatedTokensOutRaw <= 0n) throw new Error("Live quote returned no tokens");

  const spotQuotePerToken = Number(virtualQuoteReserves) / Number(virtualTokenReserves);
  const averageQuotePerToken = Number(spendableQuoteIn) / Number(estimatedTokensOutRaw);
  const impactPercent = (averageQuotePerToken / spotQuotePerToken - 1) * 100;
  if (!Number.isFinite(impactPercent) || impactPercent < 0) throw new Error("Live quote impact was invalid");

  return {
    amountSol,
    impactPercent,
    estimatedTokensOut: Number(estimatedTokensOutRaw) / 1_000_000,
    quotedAt,
  };
}

async function wait(milliseconds: number) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function verifyMigrationCandidate(candidate: LaunchCandidate, windowSeconds: number): Promise<MigrationVerification> {
  const detectedAt = candidate.detectedAt ?? Date.now();
  if ((Date.now() - detectedAt) / 1_000 > windowSeconds) throw new Error("the five-minute entry window expired");

  type MigrationTransaction = {
    blockTime?: number;
    meta?: { err?: unknown; logMessages?: string[] | null };
    transaction?: unknown;
  } | null;

  // PumpPortal publishes migration events at processed commitment. Shared RPCs can
  // take several seconds to expose the same transaction at confirmed commitment,
  // so transaction indexing must not be a hard dependency for paper entries.
  const transactionPromise = (async (): Promise<MigrationTransaction> => {
    if (!candidate.migrationSignature) return null;
    for (let attempt = 0; attempt < 7; attempt++) {
      try {
        const transaction = await rpc("getTransaction", [candidate.migrationSignature, { commitment: "confirmed", encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }]) as Exclude<MigrationTransaction, null> | null;
        if (transaction && Number(transaction.blockTime ?? 0) > 0) return transaction;
      } catch {
        // The realtime feed commonly reaches the browser before shared RPC indexes.
      }
      if (attempt < 6) await wait(250);
    }
    return null;
  })();

  let sawValidMigrationMetadata = false;
  const markPromise = (async () => {
    let latest: Awaited<ReturnType<typeof fetchPumpPrice>> | null = null;
    let previousMarketCapUsd: number | null = null;
    const verificationDeadline = detectedAt + windowSeconds * 1_000;
    while (Date.now() < verificationDeadline) {
      try {
        latest = await fetchPumpPrice(candidate.mint);
        const marketCapUsd = Number(latest.marketCapUsd);
        if (latest.complete && latest.poolAddress && Number.isFinite(marketCapUsd) && marketCapUsd > 0) {
          sawValidMigrationMetadata = true;
          if (latest.isMayhemMode) return latest;
          if (previousMarketCapUsd !== null) {
            const ratio = marketCapUsd / previousMarketCapUsd;
            if (ratio >= 0.65 && ratio <= 1.35) return latest;
          }
          previousMarketCapUsd = marketCapUsd;
        } else {
          previousMarketCapUsd = null;
        }
      } catch {
        // Pump.fun metadata can lag the migration websocket by a fraction of a second.
      }
      await wait(500);
    }
    return null;
  })();

  // Keep the optional confirmed-RPC check inside the paper sniper's latency budget.
  // The request may finish later, but it never holds a verified paper entry hostage.
  const timelyTransactionPromise = Promise.race([
    transactionPromise,
    wait(1_750).then(() => null as MigrationTransaction),
  ]);
  const [migrationTransaction, mark] = await Promise.all([timelyTransactionPromise, markPromise]);
  if (!mark && sawValidMigrationMetadata) throw new Error("a stable post-migration market cap was unavailable before the five-minute window expired");
  if (!mark) throw new Error("Pump.fun metadata was unavailable");
  if (!mark.complete) throw new Error("Pump.fun has not marked the token as migrated");
  if (!mark.poolAddress) throw new Error("a post-migration pool could not be verified");
  if (!candidate.mint.endsWith("pump")) throw new Error("non-Pump.fun launch excluded");
  if (mark.isMayhemMode) throw new Error("Mayhem coin excluded; only standard Pump.fun migrations are watched");
  if (!mark.isStandardPumpfunMigration) throw new Error(`standard Pump.fun migration mode could not be confirmed${mark.boostMode ? ` (${mark.boostMode})` : ""}`);
  if (!Number.isFinite(mark.marketCapUsd) || Number(mark.marketCapUsd) <= 0) throw new Error("a valid USD market cap was unavailable");

  let ageSeconds = Math.max(0, (Date.now() - detectedAt) / 1_000);
  if (migrationTransaction) {
    if (migrationTransaction.meta?.err) throw new Error("the migration transaction failed on Solana");
    const transactionText = JSON.stringify(migrationTransaction);
    const migrationLogs = migrationTransaction.meta?.logMessages?.join("\n") ?? "";
    const hasMigrationInstruction = /Instruction:\s*(Migrate|MigrateFunds|CreatePool)|CompletePumpAmmMigration|complete_pump_amm_migration/i.test(migrationLogs);
    if (!hasMigrationInstruction) throw new Error("the transaction did not contain a successful migration instruction");
    if (!transactionText.includes(candidate.mint)) throw new Error("the migration transaction did not contain this token mint");
    const blockTime = Number(migrationTransaction.blockTime ?? 0);
    ageSeconds = Date.now() / 1_000 - blockTime;
    if (ageSeconds < -15 || ageSeconds > windowSeconds) throw new Error("migration is older than the five-minute window");
  }

  return {
    ageSeconds,
    candidate: {
      ...candidate,
      ...mark,
      isMayhemMode: mark.isMayhemMode,
      boostMode: mark.boostMode,
      isStandardPumpfunMigration: mark.isStandardPumpfunMigration,
      symbol: mark.symbol ?? candidate.symbol,
      name: mark.name ?? candidate.name,
    },
  };
}

export function openLaunchFeed(onCandidate: (candidate: LaunchCandidate) => void, onStatus: (status: "connecting" | "live" | "error") => void) {
  const socket = new WebSocket("wss://pumpportal.fun/api/data");
  socket.addEventListener("open", () => {
    onStatus("live");
    socket.send(JSON.stringify({ method: "subscribeNewToken" }));
  });
  socket.addEventListener("error", () => onStatus("error"));
  socket.addEventListener("message", (event) => {
    try {
      const data = JSON.parse(String(event.data));
      if (data.txType !== "create" || typeof data.mint !== "string") return;
      const solReserve = Number(data.vSolInBondingCurve);
      const tokenReserve = Number(data.vTokensInBondingCurve);
      const priceSol = solReserve > 0 && tokenReserve > 0 ? solReserve / tokenReserve : NaN;
      if (!Number.isFinite(priceSol) || priceSol <= 0) return;
      onCandidate({
        mint: data.mint,
        symbol: typeof data.symbol === "string" ? data.symbol : "NEW",
        name: typeof data.name === "string" ? data.name : "New token",
        priceSol,
        marketCapSol: Number(data.marketCapSol) || priceSol * 1_000_000_000,
        marketCapUsd: Number(data.marketCapUsd) || undefined,
        virtualSolReserves: solReserve,
        virtualTokenReserves: tokenReserve,
      });
    } catch { /* ignore malformed feed frames */ }
  });
  onStatus("connecting");
  return () => socket.close();
}

export function openMigrationFeed(
  onCandidate: (candidate: LaunchCandidate, watchTokenTrades: TokenTradeWatcher | null) => void,
  onStatus: (status: "connecting" | "live" | "error") => void,
  apiKey = "",
) {
  const seen = new Set<string>();
  const tradeListeners = new Map<string, Set<(mark: LaunchCandidate) => void>>();
  const streamKey = apiKey.trim();
  let socket: WebSocket | null = null;
  let stopped = false;
  let reconnectTimer: number | null = null;
  let reconnectAttempt = 0;

  const send = (payload: Record<string, unknown>) => {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
  };

  const watchTokenTrades: TokenTradeWatcher | null = streamKey ? (mint, onTrade) => {
    const listeners = tradeListeners.get(mint) ?? new Set<(mark: LaunchCandidate) => void>();
    const firstListener = listeners.size === 0;
    listeners.add(onTrade);
    tradeListeners.set(mint, listeners);
    if (firstListener) send({ method: "subscribeTokenTrade", keys: [mint] });
    return () => {
      const current = tradeListeners.get(mint);
      current?.delete(onTrade);
      if (!current || current.size === 0) {
        tradeListeners.delete(mint);
        send({ method: "unsubscribeTokenTrade", keys: [mint] });
      }
    };
  } : null;

  const handleMessage = (event: MessageEvent) => {
    try {
      const data = JSON.parse(String(event.data)) as Record<string, unknown>;
      const mint = typeof data.mint === "string" ? data.mint : "";
      if (!mint) return;
      const listeners = tradeListeners.get(mint);
      if (listeners?.size) {
        const marketCapSol = Number(data.marketCapSol);
        const marketCapUsd = Number(data.marketCapUsd);
        if (Number.isFinite(marketCapSol) && marketCapSol > 0) {
          const mark: LaunchCandidate = {
            mint,
            symbol: typeof data.symbol === "string" ? data.symbol : "MIG",
            name: typeof data.name === "string" ? data.name : "Migrated token",
            priceSol: marketCapSol / 1_000_000_000,
            marketCapSol,
            marketCapUsd: Number.isFinite(marketCapUsd) && marketCapUsd > 0 ? marketCapUsd : undefined,
          };
          listeners.forEach((listener) => listener(mark));
        }
        return;
      }
      const txType = typeof data.txType === "string" ? data.txType.toLowerCase() : "";
      const isMigrationEvent = !txType || /migrat/.test(txType);
      if (!isMigrationEvent || seen.has(mint)) return;
      seen.add(mint);

      const symbol = typeof data.symbol === "string" ? data.symbol : "MIG";
      const name = typeof data.name === "string" ? data.name : "Migrated token";
      const marketCapSol = Number(data.marketCapSol);
      const solReserve = Number(data.vSolInBondingCurve ?? data.vSolInPool);
      const tokenReserve = Number(data.vTokensInBondingCurve ?? data.vTokensInPool);
      const priceSol = solReserve > 0 && tokenReserve > 0 ? solReserve / tokenReserve : NaN;
      const signature = typeof data.signature === "string" ? data.signature : typeof data.txSignature === "string" ? data.txSignature : "";
      onCandidate({
        mint,
        symbol,
        name,
        priceSol,
        marketCapSol: Number.isFinite(marketCapSol) && marketCapSol > 0 ? marketCapSol : priceSol * 1_000_000_000,
        marketCapUsd: Number(data.marketCapUsd) || undefined,
        migrationSignature: isMigrationEvent ? signature : undefined,
        detectedAt: Date.now(),
      }, watchTokenTrades);
    } catch { /* ignore malformed feed frames */ }
  };

  const connect = () => {
    if (stopped) return;
    onStatus("connecting");
    const nextSocket = new WebSocket(streamKey
      ? `wss://pumpportal.fun/api/data?api-key=${encodeURIComponent(streamKey)}`
      : "wss://pumpportal.fun/api/data");
    socket = nextSocket;
    nextSocket.addEventListener("open", () => {
      if (stopped || socket !== nextSocket) return;
      reconnectAttempt = 0;
      onStatus("live");
      send({ method: "subscribeMigration" });
      if (streamKey) tradeListeners.forEach((_listeners, mint) => send({ method: "subscribeTokenTrade", keys: [mint] }));
    });
    nextSocket.addEventListener("message", handleMessage);
    nextSocket.addEventListener("error", () => {
      if (!stopped && socket === nextSocket) onStatus("error");
    });
    nextSocket.addEventListener("close", () => {
      if (stopped || socket !== nextSocket) return;
      onStatus("error");
      socket = null;
      const delay = Math.min(5_000, 400 * (2 ** reconnectAttempt));
      reconnectAttempt = Math.min(reconnectAttempt + 1, 4);
      reconnectTimer = window.setTimeout(connect, delay);
    });
  };

  onStatus("connecting");
  connect();
  return () => {
    stopped = true;
    if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
    socket?.close();
    socket = null;
  };
    }
