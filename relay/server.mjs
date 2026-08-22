import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";

const PORT = Number(process.env.PORT) || 8080;
const PUMPPORTAL_API_KEY = process.env.PUMPPORTAL_API_KEY?.trim() ?? "";
const RELAY_SECRET = process.env.LOCKSTEP_RELAY_SECRET?.trim() ?? "";
const MINT_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const MAX_MINTS_PER_STREAM = 96;
const MAX_ACTIVE_TOKENS = 128;
const MAX_LISTENERS_PER_TOKEN = 32;
const STREAM_LIFETIME_MS = 285_000;
const HEARTBEAT_MS = 15_000;
const RECONNECT_MAX_MS = 5_000;
const PUMP_AMM_PROGRAM = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
const BUY_EVENT_DISCRIMINATOR = Buffer.from([103, 244, 82, 31, 44, 245, 119, 119]);
const BUY_EVENT_POOL_OFFSET = 120;
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const SOLANA_WS_URL = (() => {
  const explicit = process.env.SOLANA_WS_URL?.trim();
  if (explicit) return explicit;
  const rpc = process.env.SOLANA_RPC_URL?.trim()
    || process.env.HELIUS_RPC_URL?.trim()
    || process.env.NEXT_PUBLIC_HELIUS_RPC_URL?.trim();
  if (rpc) return rpc.replace(/^https:/i, "wss:").replace(/^http:/i, "ws:");
  const heliusKey = process.env.HELIUS_API_KEY?.trim();
  if (heliusKey) return `wss://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(heliusKey)}`;
  return "wss://api.mainnet-beta.solana.com";
})();

if (!PUMPPORTAL_API_KEY) throw new Error("PUMPPORTAL_API_KEY is required");
if (RELAY_SECRET.length < 24) throw new Error("LOCKSTEP_RELAY_SECRET must contain at least 24 characters");

function authorized(request) {
  const supplied = request.headers.authorization?.replace(/^Bearer\s+/i, "") ?? "";
  const expected = Buffer.from(RELAY_SECRET);
  const received = Buffer.from(supplied);
  return received.length === expected.length && timingSafeEqual(received, expected);
}

function sendJson(response, status, payload) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(payload));
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function encodeBase58(bytes) {
  if (!bytes.length) return "";
  const digits = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let index = 0; index < digits.length; index += 1) {
      carry += digits[index] << 8;
      digits[index] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  let leadingZeroes = 0;
  while (leadingZeroes < bytes.length && bytes[leadingZeroes] === 0) leadingZeroes += 1;
  let encoded = "1".repeat(leadingZeroes);
  if (leadingZeroes === bytes.length) return encoded;
  for (let index = digits.length - 1; index >= 0; index -= 1) encoded += BASE58_ALPHABET[digits[index]];
  return encoded;
}

function buyEventPoolFromLog(line) {
  if (typeof line !== "string" || !line.startsWith("Program data: ")) return null;
  try {
    const event = Buffer.from(line.slice("Program data: ".length), "base64");
    if (event.length < BUY_EVENT_POOL_OFFSET + 32
      || !event.subarray(0, 8).equals(BUY_EVENT_DISCRIMINATOR)) return null;
    return encodeBase58(event.subarray(BUY_EVENT_POOL_OFFSET, BUY_EVENT_POOL_OFFSET + 32));
  } catch {
    return null;
  }
}

class ProcessedPumpSwapSignals {
  socket = null;
  reconnectTimer = null;
  reconnectAttempt = 0;
  connectedAt = null;
  seenSignatures = new Set();

  constructor(onPoolSignal) {
    this.onPoolSignal = onPoolSignal;
  }

  start() {
    this.ensureConnected();
  }

  status() {
    let endpoint = "configured";
    try { endpoint = new URL(SOLANA_WS_URL).hostname; } catch { /* Keep secrets out of health output. */ }
    return {
      state: this.socket?.readyState === WebSocket.OPEN ? "connected" : "connecting",
      endpoint,
      connectedAt: this.connectedAt,
    };
  }

  ensureConnected() {
    if (this.socket || this.reconnectTimer) return;
    const socket = new WebSocket(SOLANA_WS_URL);
    this.socket = socket;
    socket.addEventListener("open", () => {
      if (this.socket !== socket) return;
      this.reconnectAttempt = 0;
      this.connectedAt = new Date().toISOString();
      socket.send(JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "logsSubscribe",
        params: [{ mentions: [PUMP_AMM_PROGRAM] }, { commitment: "processed" }],
      }));
    });
    socket.addEventListener("message", (event) => this.handleMessage(event));
    socket.addEventListener("error", () => {
      // A failed WebSocket emits close next; that handler schedules the reconnect.
    });
    socket.addEventListener("close", () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.connectedAt = null;
      const delay = Math.min(RECONNECT_MAX_MS, 400 * (2 ** this.reconnectAttempt));
      this.reconnectAttempt = Math.min(this.reconnectAttempt + 1, 4);
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.ensureConnected();
      }, delay);
    });
  }

  handleMessage(event) {
    try {
      const data = JSON.parse(String(event.data));
      const value = data.params?.result?.value;
      const signature = typeof value?.signature === "string" ? value.signature : "";
      if (!signature || value?.err || this.seenSignatures.has(signature)) return;
      this.seenSignatures.add(signature);
      if (this.seenSignatures.size > 4_096) this.seenSignatures.delete(this.seenSignatures.values().next().value);
      for (const line of value.logs ?? []) {
        const pool = buyEventPoolFromLog(line);
        if (pool) {
          this.onPoolSignal(pool, signature);
          return;
        }
      }
    } catch {
      // Ignore malformed RPC frames.
    }
  }
}

class PumpPortalRelay {
  socket = null;
  listeners = new Map();
  reconnectTimer = null;
  reconnectAttempt = 0;
  connectedAt = null;
  poolByMint = new Map();
  mintByPool = new Map();
  poolResolutions = new Map();

  start() {
    this.ensureConnected();
  }

  subscribe(mint, listener) {
    let tokenListeners = this.listeners.get(mint);
    if (!tokenListeners) {
      if (this.listeners.size >= MAX_ACTIVE_TOKENS) throw new Error("relay-capacity");
      tokenListeners = new Set();
      this.listeners.set(mint, tokenListeners);
    }
    if (tokenListeners.size >= MAX_LISTENERS_PER_TOKEN) throw new Error("token-capacity");
    tokenListeners.add(listener);
    this.ensureConnected();
    this.ensurePoolMapping(mint);
    if (tokenListeners.size === 1) this.send({ method: "subscribeTokenTrade", keys: [mint] });

    let removed = false;
    return () => {
      if (removed) return;
      removed = true;
      const current = this.listeners.get(mint);
      current?.delete(listener);
      if (current?.size === 0) {
        this.listeners.delete(mint);
        this.send({ method: "unsubscribeTokenTrade", keys: [mint] });
        const pool = this.poolByMint.get(mint);
        if (pool) this.mintByPool.delete(pool);
        this.poolByMint.delete(mint);
      }
    };
  }

  ensurePoolMapping(mint) {
    if (this.poolByMint.has(mint) || this.poolResolutions.has(mint)) return;
    const resolution = (async () => {
      for (let attempt = 0; attempt < 30 && this.listeners.has(mint); attempt += 1) {
        if (attempt) await sleep(Math.min(1_000, 150 + attempt * 75));
        try {
          const response = await fetch(`https://frontend-api-v3.pump.fun/coins-v2/${mint}`, {
            cache: "no-store",
            signal: AbortSignal.timeout(1_500),
          });
          if (!response.ok) continue;
          const payload = await response.json();
          const coin = payload?.data ?? payload;
          const pool = [coin?.pool_address, coin?.raydium_pool, coin?.pump_swap_pool, coin?.pumpswap_pool]
            .find((value) => typeof value === "string" && MINT_PATTERN.test(value));
          if (!pool || !this.listeners.has(mint)) continue;
          const previous = this.poolByMint.get(mint);
          if (previous) this.mintByPool.delete(previous);
          this.poolByMint.set(mint, pool);
          this.mintByPool.set(pool, mint);
          return;
        } catch {
          // Metadata can lag migration; retry while this token is actively watched.
        }
      }
    })().finally(() => this.poolResolutions.delete(mint));
    this.poolResolutions.set(mint, resolution);
  }

  signalPool(pool, signature) {
    const mint = this.mintByPool.get(pool);
    if (!mint) return;
    const tokenListeners = this.listeners.get(mint);
    if (!tokenListeners?.size) return;
    const frame = {
      mint,
      pool,
      signalOnly: true,
      source: "helius-processed",
      signature,
      receivedAt: Date.now(),
    };
    tokenListeners.forEach((listener) => listener(frame));
  }

  status() {
    return {
      ok: true,
      upstream: this.socket?.readyState === WebSocket.OPEN ? "connected" : "connecting",
      activeTokens: this.listeners.size,
      connectedAt: this.connectedAt,
    };
  }

  ensureConnected() {
    if (this.socket || this.reconnectTimer) return;
    const socket = new WebSocket(`wss://pumpportal.fun/api/data?api-key=${encodeURIComponent(PUMPPORTAL_API_KEY)}`);
    this.socket = socket;
    socket.addEventListener("open", () => {
      if (this.socket !== socket) return;
      this.reconnectAttempt = 0;
      this.connectedAt = new Date().toISOString();
      this.send({ method: "subscribeMigration" });
      this.listeners.forEach((_listeners, mint) => this.send({ method: "subscribeTokenTrade", keys: [mint] }));
    });
    socket.addEventListener("message", (event) => this.handleMessage(event));
    socket.addEventListener("error", () => {
      // A failed WebSocket emits close next; that handler schedules the reconnect.
    });
    socket.addEventListener("close", () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.connectedAt = null;
      const delay = Math.min(RECONNECT_MAX_MS, 400 * (2 ** this.reconnectAttempt));
      this.reconnectAttempt = Math.min(this.reconnectAttempt + 1, 4);
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.ensureConnected();
      }, delay);
    });
  }

  send(payload) {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(payload));
  }

  handleMessage(event) {
    try {
      const data = JSON.parse(String(event.data));
      const mint = typeof data.mint === "string" ? data.mint : "";
      const marketCapSol = Number(data.marketCapSol);
      if (!mint || !Number.isFinite(marketCapSol) || marketCapSol <= 0) return;
      const tokenListeners = this.listeners.get(mint);
      if (!tokenListeners?.size) return;
      const marketCapUsd = Number(data.marketCapUsd);
      const frame = {
        mint,
        marketCapSol,
        marketCapUsd: Number.isFinite(marketCapUsd) && marketCapUsd > 0 ? marketCapUsd : undefined,
        symbol: typeof data.symbol === "string" ? data.symbol.slice(0, 24) : undefined,
        name: typeof data.name === "string" ? data.name.slice(0, 80) : undefined,
        pool: typeof data.pool === "string" ? data.pool.slice(0, 64) : undefined,
        receivedAt: Date.now(),
      };
      tokenListeners.forEach((listener) => listener(frame));
    } catch {
      // Ignore malformed upstream messages.
    }
  }
}

const relay = new PumpPortalRelay();
const processedSignals = new ProcessedPumpSwapSignals((pool, signature) => relay.signalPool(pool, signature));
relay.start();
processedSignals.start();

const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  if (request.method === "GET" && url.pathname === "/health") {
    sendJson(response, 200, { ...relay.status(), processedUpstream: processedSignals.status() });
    return;
  }
  if (request.method !== "GET" || url.pathname !== "/trades") {
    sendJson(response, 404, { error: "Not found" });
    return;
  }
  if (!authorized(request)) {
    sendJson(response, 401, { error: "Unauthorized" });
    return;
  }
  const mints = [...new Set(url.searchParams.getAll("mint"))];
  if (mints.length === 0 || mints.length > MAX_MINTS_PER_STREAM || mints.some((mint) => !MINT_PATTERN.test(mint))) {
    sendJson(response, 400, { error: "Invalid token list" });
    return;
  }

  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "private, no-store, no-cache, must-revalidate, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
    "x-content-type-options": "nosniff",
  });
  response.write(": connected\n\n");

  let closed = false;
  let unsubscribe;
  let heartbeat;
  let expiry;
  const finish = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    clearTimeout(expiry);
    unsubscribe?.();
    if (!response.writableEnded) response.end();
  };
  const unsubscribers = [];
  try {
    mints.forEach((mint) => unsubscribers.push(relay.subscribe(mint, (frame) => {
      if (!closed) response.write(`data: ${JSON.stringify(frame)}\n\n`);
    })));
    unsubscribe = () => unsubscribers.forEach((stop) => stop());
  } catch {
    unsubscribers.forEach((stop) => stop());
    response.write(`event: relay-error\ndata: ${JSON.stringify({ error: "Live trade feed is busy" })}\n\n`);
    finish();
    return;
  }
  heartbeat = setInterval(() => {
    if (!closed) response.write(": keepalive\n\n");
  }, HEARTBEAT_MS);
  expiry = setTimeout(finish, STREAM_LIFETIME_MS);
  request.once("close", finish);
  response.once("close", finish);
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Lockstep relay listening on ${PORT}`);
});

function shutdown() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5_000).unref();
}

process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
