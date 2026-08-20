type TradeFrame = {
  mint: string;
  marketCapSol: number;
  marketCapUsd?: number;
  symbol?: string;
  name?: string;
  pool?: string;
};

type TradeListener = (frame: TradeFrame) => void;

const MAX_ACTIVE_TOKENS = 64;
const MAX_LISTENERS_PER_TOKEN = 32;
const IDLE_CLOSE_MS = 5_000;
const RECONNECT_MAX_MS = 5_000;

class PumpPortalRelay {
  private socket: WebSocket | null = null;
  private listeners = new Map<string, Set<TradeListener>>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private stopped = false;

  subscribe(mint: string, listener: TradeListener) {
    let tokenListeners = this.listeners.get(mint);
    if (!tokenListeners) {
      if (this.listeners.size >= MAX_ACTIVE_TOKENS) throw new Error("relay-capacity");
      tokenListeners = new Set();
      this.listeners.set(mint, tokenListeners);
    }
    if (tokenListeners.size >= MAX_LISTENERS_PER_TOKEN) throw new Error("token-capacity");

    tokenListeners.add(listener);
    this.stopped = false;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
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
      if (this.listeners.size === 0) this.scheduleIdleClose();
    };
  }

  private ensureConnected() {
    if (this.socket || this.reconnectTimer || this.listeners.size === 0) return;
    const apiKey = process.env.PUMPPORTAL_API_KEY?.trim();
    if (!apiKey) return;

    const socket = new WebSocket(`wss://pumpportal.fun/api/data?api-key=${encodeURIComponent(apiKey)}`);
    this.socket = socket;
    socket.addEventListener("open", () => {
      if (this.socket !== socket) return;
      this.reconnectAttempt = 0;
      this.listeners.forEach((_listeners, mint) => this.send({ method: "subscribeTokenTrade", keys: [mint] }));
    });
    socket.addEventListener("message", (event) => this.handleMessage(event));
    socket.addEventListener("error", () => socket.close());
    socket.addEventListener("close", () => {
      if (this.socket !== socket) return;
      this.socket = null;
      if (this.stopped || this.listeners.size === 0) return;
      const delay = Math.min(RECONNECT_MAX_MS, 400 * (2 ** this.reconnectAttempt));
      this.reconnectAttempt = Math.min(this.reconnectAttempt + 1, 4);
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        this.ensureConnected();
      }, delay);
    });
  }

  private send(payload: Record<string, unknown>) {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(payload));
  }

  private handleMessage(event: MessageEvent) {
    try {
      const data = JSON.parse(String(event.data)) as Record<string, unknown>;
      const mint = typeof data.mint === "string" ? data.mint : "";
      const marketCapSol = Number(data.marketCapSol);
      if (!mint || !Number.isFinite(marketCapSol) || marketCapSol <= 0) return;
      const tokenListeners = this.listeners.get(mint);
      if (!tokenListeners?.size) return;
      const marketCapUsd = Number(data.marketCapUsd);
      const frame: TradeFrame = {
        mint,
        marketCapSol,
        marketCapUsd: Number.isFinite(marketCapUsd) && marketCapUsd > 0 ? marketCapUsd : undefined,
        symbol: typeof data.symbol === "string" ? data.symbol.slice(0, 24) : undefined,
        name: typeof data.name === "string" ? data.name.slice(0, 80) : undefined,
        pool: typeof data.pool === "string" ? data.pool.slice(0, 32) : undefined,
      };
      tokenListeners.forEach((listener) => listener(frame));
    } catch {
      // Ignore malformed upstream frames without exposing the private endpoint.
    }
  }

  private scheduleIdleClose() {
    if (this.idleTimer) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.listeners.size !== 0) return;
      this.stopped = true;
      if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
      this.socket?.close();
      this.socket = null;
    }, IDLE_CLOSE_MS);
  }
}

declare global {
  var lockstepPumpPortalRelay: PumpPortalRelay | undefined;
}

export const pumpPortalRelay = globalThis.lockstepPumpPortalRelay ?? new PumpPortalRelay();
globalThis.lockstepPumpPortalRelay = pumpPortalRelay;
