import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";

const PORT = Number(process.env.PORT) || 8080;
const PUMPPORTAL_API_KEY = process.env.PUMPPORTAL_API_KEY?.trim() ?? "";
const RELAY_SECRET = process.env.LOCKSTEP_RELAY_SECRET?.trim() ?? "";
const MINT_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const MAX_ACTIVE_TOKENS = 64;
const MAX_LISTENERS_PER_TOKEN = 32;
const STREAM_LIFETIME_MS = 285_000;
const HEARTBEAT_MS = 15_000;
const RECONNECT_MAX_MS = 5_000;

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

class PumpPortalRelay {
  socket = null;
  listeners = new Map();
  reconnectTimer = null;
  reconnectAttempt = 0;
  connectedAt = null;

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
      }
    };
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
    socket.addEventListener("error", () => socket.close());
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
relay.start();

const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  if (request.method === "GET" && url.pathname === "/health") {
    sendJson(response, 200, relay.status());
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
  const mint = url.searchParams.get("mint") ?? "";
  if (!MINT_PATTERN.test(mint)) {
    sendJson(response, 400, { error: "Invalid token" });
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
  try {
    unsubscribe = relay.subscribe(mint, (frame) => {
      if (!closed) response.write(`data: ${JSON.stringify(frame)}\n\n`);
    });
  } catch {
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
