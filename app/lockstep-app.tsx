"use client";
/* eslint-disable @next/next/no-img-element */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Keypair, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import QRCode from "qrcode";
import { gcm } from "@noble/ciphers/aes";
import { pbkdf2Async } from "@noble/hashes/pbkdf2";
import { sha256 } from "@noble/hashes/sha256";
import { utf8ToBytes } from "@noble/hashes/utils";
import { buildExactPaperBuy, buildSignAndSendTrade, fetchLiveBuyQuote, fetchPumpPrice, openLaunchFeed, openMigrationFeed, verifyMigrationCandidate, type LaunchCandidate, type LivePosition, type TokenTradeWatcher } from "./trading";

type StoredWallet = {
  version: 1;
  address: string;
  salt: string;
  iv: string;
  ciphertext: string;
  createdAt: number;
};

type EngineMode = "paused" | "active" | "protect";
type OnboardingMode = "choose" | "create" | "import" | "unlock";
type StrategyMode = "migration-live" | "migration-paper" | "new-pairs-live";
type ActivityItem = { id: string; time: number; title: string; detail: string; tone: "good" | "warn" | "neutral"; mint?: string };

const STORAGE_KEY = "lockstep.wallet.v1";
const SETTINGS_KEY = "lockstep.settings.v1";
const MIGRATION_SETTINGS_KEY = "lockstep.settings.migration.v14";
const MIGRATION_LIVE_SETTINGS_KEY = "lockstep.settings.migration-live.v2";
const NEW_PAIRS_SETTINGS_KEY = "lockstep.settings.new-pairs.v3";
const POSITIONS_KEY = "lockstep.positions.v1";
const PNL_KEY = "lockstep.daily-pnl.v1";
const SOL_USD_KEY = "lockstep.sol-usd.v1";
const STRATEGY_MODE_KEY = "lockstep.strategy-mode.v1";
const PAPER_POSITIONS_KEY = "lockstep.paper-positions.v6";
const PAPER_ACCOUNT_KEY = "lockstep.paper-account.v5";
const ACTIVITY_KEY = "lockstep.session-receipts.v1";
const MIGRATION_WINDOW_SECONDS = 300;
const MIGRATION_WATCH_POLL_MS = 500;
const PAPER_ESTIMATED_QUOTE_LIQUIDITY_SHARE = 0.2;
const PAPER_TRADING_FEE_PERCENT = 1.25;
const PAPER_PRIORITY_FEE_SOL = 0.0005;

const defaults = {
  buyAmount: 0.3,
  adaptiveBuyAmount: 0.5,
  maxQuoteImpact: 8,
  maxPositions: 1,
  dailyLoss: 0.1,
  slippage: 8,
  stopLoss: 25,
  takeProfit: 50,
  maxHold: 120,
  paperStartingBalance: 1,
};

const migrationDefaults = {
  ...defaults,
  buyAmount: 5,
  slippage: 50,
  exitImpact: 15,
  maxPositions: 1,
  dailyLoss: 5,
  takeProfit: 300,
  maxHold: 300,
  paperStartingBalance: 10,
  boostEntryMinMarketCapUsd: 1600,
  boostEntryMarketCapUsd: 2400,
  boostSellSlicePercent: 10,
  boostSellIntervalSeconds: 12,
};

const migrationLiveDefaults = {
  ...migrationDefaults,
  paperStartingBalance: 0,
};

const LIVE_WALLET_RESERVE_SOL = 0.005;
const LIVE_QUOTE_MAX_AGE_MS = 2_000;

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  bytes.forEach((byte) => (binary += String.fromCharCode(byte)));
  return btoa(binary);
}

function base64ToBytes(value: string) {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

async function deriveKey(password: string, salt: Uint8Array) {
  return pbkdf2Async(sha256, utf8ToBytes(password), salt, { c: 310_000, dkLen: 32 });
}

async function encryptWallet(secretKey: Uint8Array, password: string, address: string): Promise<StoredWallet> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt);
  const ciphertext = gcm(key, iv).encrypt(secretKey);
  return {
    version: 1,
    address,
    salt: bytesToBase64(salt),
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(ciphertext),
    createdAt: Date.now(),
  };
}

async function decryptWallet(wallet: StoredWallet, password: string) {
  const salt = base64ToBytes(wallet.salt);
  const iv = base64ToBytes(wallet.iv);
  const key = await deriveKey(password, salt);
  const plaintext = gcm(key, iv).decrypt(base64ToBytes(wallet.ciphertext));
  const keypair = Keypair.fromSecretKey(plaintext);
  if (keypair.publicKey.toBase58() !== wallet.address) throw new Error("Wallet address does not match encrypted key");
  return keypair;
}

function parseImportedSecret(value: string): Keypair {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("Paste a private key or upload a keypair JSON file");
  let secret: Uint8Array;
  if (trimmed.startsWith("[")) {
    const parsed = JSON.parse(trimmed);
    if (!Array.isArray(parsed) || parsed.length !== 64) throw new Error("Keypair JSON must contain 64 numbers");
    secret = Uint8Array.from(parsed);
  } else {
    secret = bs58.decode(trimmed);
  }
  return Keypair.fromSecretKey(secret);
}

function parseEncryptedBackup(value: string): StoredWallet | null {
  try {
    const parsed = JSON.parse(value) as Partial<StoredWallet>;
    if (parsed.version === 1 && typeof parsed.address === "string" && typeof parsed.salt === "string" && typeof parsed.iv === "string" && typeof parsed.ciphertext === "string") return parsed as StoredWallet;
  } catch { /* not an encrypted Lockstep backup */ }
  return null;
}

function shortAddress(address: string) {
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}

function makeId() {
  return Array.from(crypto.getRandomValues(new Uint8Array(12)), (value) => value.toString(16).padStart(2, "0")).join("");
}

function formatMarketCap(valueSol: number, solUsdPrice: number, directUsd?: number) {
  const value = Number.isFinite(directUsd) && Number(directUsd) > 0 ? Number(directUsd) : valueSol * solUsdPrice;
  if (!Number.isFinite(value) || value <= 0) return "— MC";
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(value >= 10_000_000 ? 1 : 2)}M MC`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(value >= 10_000 ? 1 : 2)}K MC`;
  return `$${value.toFixed(value >= 100 ? 0 : 2)} MC`;
}

function paperMarkRatio(position: LivePosition, nextMarketCapUsd = position.currentMarketCapUsd) {
  const entry = Number(position.entryMarketCapUsd);
  const mark = Number(nextMarketCapUsd);
  if (!Number.isFinite(entry) || entry <= 0 || !Number.isFinite(mark) || mark <= 0) return NaN;
  const initialValueRatio = Number.isFinite(position.paperInitialTokenValueSol) && Number(position.paperInitialTokenValueSol) > 0
    ? Number(position.paperInitialTokenValueSol) / position.amountSol
    : 1;
  return mark / entry * initialValueRatio;
}

function estimatedPaperPriceImpactPercent(notionalSol: number, marketCapUsd: number | undefined, solUsdPrice: number) {
  const estimatedQuoteLiquiditySol = Number(marketCapUsd) * PAPER_ESTIMATED_QUOTE_LIQUIDITY_SHARE / solUsdPrice;
  if (!Number.isFinite(estimatedQuoteLiquiditySol) || estimatedQuoteLiquiditySol <= 0) return Infinity;
  return notionalSol / estimatedQuoteLiquiditySol * 100;
}

function executablePaperSellProceeds(grossProceedsSol: number, marketCapUsd: number | undefined, solUsdPrice: number, maximumImpactPercent: number) {
  const impactPercent = estimatedPaperPriceImpactPercent(grossProceedsSol, marketCapUsd, solUsdPrice);
  if (!Number.isFinite(impactPercent) || impactPercent > maximumImpactPercent) return { proceedsSol: 0, impactPercent, executable: false };
  const afterImpact = grossProceedsSol * (1 - impactPercent / 100);
  const afterFees = afterImpact * (1 - PAPER_TRADING_FEE_PERCENT / 100) - PAPER_PRIORITY_FEE_SOL;
  return { proceedsSol: Math.max(0, afterFees), impactPercent, executable: afterFees > 0 };
}

function describeLiveEntryFailure(rawMessage: string): string {
  if (/custom.*:\s*1\b/i.test(rawMessage) || /custom program error: 0x1\b/i.test(rawMessage)) {
    return "price moved past the slippage limit before the order landed on-chain";
  }
  if (/custom.*:\s*6004\b/i.test(rawMessage)) {
    return "the pool routing was stale, this coin had already migrated off the bonding curve";
  }
  if (/confirmation timed out/i.test(rawMessage)) {
    return "the transaction never confirmed in time, likely network congestion or it was dropped";
  }
  if (/could not build transaction/i.test(rawMessage)) {
    return "the trade builder could not prepare an order for this coin";
  }
  if (/insufficient/i.test(rawMessage)) {
    return "not enough SOL in the wallet for this order";
  }
  if (/blockhash/i.test(rawMessage)) {
    return "the transaction expired before it could land, the network was too slow";
  }
  return rawMessage;
}

function formatUsdMarketCap(value?: number) {
  const marketCap = Number(value);
  if (!Number.isFinite(marketCap) || marketCap <= 0) return "— MC";
  if (marketCap >= 1_000_000) return `$${(marketCap / 1_000_000).toFixed(2)}M MC`;
  if (marketCap >= 1_000) return `$${(marketCap / 1_000).toFixed(2)}K MC`;
  return `$${marketCap.toFixed(marketCap >= 100 ? 0 : 2)} MC`;
}

async function getBalance(address: string) {
  const response = await fetch("/api/rpc", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ method: "getBalance", params: [address, { commitment: "confirmed" }] }),
  });
  const payload = await response.json();
  if (!response.ok || payload.error) throw new Error(payload.error?.message ?? payload.error ?? "Balance unavailable");
  return Number(payload.result?.value ?? 0) / 1_000_000_000;
}

async function getChangedBalance(address: string, previous: number, direction: "lower" | "higher") {
  let latest = previous;
  for (let attempt = 0; attempt < 5; attempt++) {
    latest = await getBalance(address);
    if (direction === "lower" ? latest < previous : latest > previous) return latest;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return latest;
}

export default function LockstepApp() {
  const keypairRef = useRef<Keypair | null>(null);
  const [storedWallet, setStoredWallet] = useState<StoredWallet | null>(null);
  const [onboarding, setOnboarding] = useState<OnboardingMode>("choose");
  const [unlocked, setUnlocked] = useState(false);
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [importValue, setImportValue] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [balance, setBalance] = useState(0);
  const [balanceState, setBalanceState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [balanceError, setBalanceError] = useState("");
  const [solUsdPrice, setSolUsdPrice] = useState(75.89);
  const [qr, setQr] = useState("");
  const [copied, setCopied] = useState(false);
  const [engineMode, setEngineMode] = useState<EngineMode>("paused");
  const [strategyMode, setStrategyMode] = useState<StrategyMode>("migration-paper");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [migrationSettings, setMigrationSettings] = useState(migrationDefaults);
  const [migrationLiveSettings, setMigrationLiveSettings] = useState(migrationLiveDefaults);
  const [newPairsSettings, setNewPairsSettings] = useState(defaults);
  const activeSettings = strategyMode === "migration-paper" ? migrationSettings : strategyMode === "migration-live" ? migrationLiveSettings : newPairsSettings;
  const [positions, setPositions] = useState<LivePosition[]>([]);
  const positionsRef = useRef<LivePosition[]>([]);
  const [paperPositions, setPaperPositions] = useState<LivePosition[]>([]);
  const paperPositionsRef = useRef<LivePosition[]>([]);
  const [paperCash, setPaperCash] = useState(migrationDefaults.paperStartingBalance);
  const paperCashRef = useRef(migrationDefaults.paperStartingBalance);
  const [paperRealizedPnl, setPaperRealizedPnl] = useState(0);
  const paperRealizedPnlRef = useRef(0);
  const [realizedPnl, setRealizedPnl] = useState(0);
  const [feedStatus, setFeedStatus] = useState<"off" | "connecting" | "live" | "error">("off");
  const entryInFlight = useRef(false);
  const liveTradeInFlight = useRef(false);
  const exitInFlight = useRef(new Set<string>());
  const migrationVerificationInFlight = useRef(new Set<string>());
  const migrationWatchInFlight = useRef(new Set<string>());
  const paperExitInFlight = useRef(new Set<string>());
  const paperPollInFlight = useRef(false);
  const processedMigrationMints = useRef(new Set<string>());
  const unstableMarkWarnings = useRef(new Set<string>());
  const migrationEntryFailureStreak = useRef(0);
  const newPairsEntryFailureStreak = useRef(0);
  const engineModeRef = useRef<EngineMode>("paused");
  const strategyModeRef = useRef<StrategyMode>("migration-paper");
  const [executionActivity, setExecutionActivity] = useState<ActivityItem[]>([]);
  const [activationOpen, setActivationOpen] = useState(false);
  const [backupOpen, setBackupOpen] = useState(false);
  const [backupPassword, setBackupPassword] = useState("");
  const [backupAcknowledged, setBackupAcknowledged] = useState(false);
  const [backupError, setBackupError] = useState("");
  const [backupBusy, setBackupBusy] = useState(false);
  const [revealedPrivateKey, setRevealedPrivateKey] = useState("");
  const [privateKeyVisible, setPrivateKeyVisible] = useState(false);
  const [privateKeyCopied, setPrivateKeyCopied] = useState(false);
  const privateKeyClearTimer = useRef<number | null>(null);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => () => {
    if (privateKeyClearTimer.current !== null) window.clearTimeout(privateKeyClearTimer.current);
  }, []);

  useEffect(() => {
    const hydrate = window.setTimeout(() => {
      const rawWallet = localStorage.getItem(STORAGE_KEY);
      if (rawWallet) {
        try {
          const parsed = JSON.parse(rawWallet) as StoredWallet;
          new PublicKey(parsed.address);
          setStoredWallet(parsed);
          setOnboarding("unlock");
        } catch {
          localStorage.removeItem(STORAGE_KEY);
        }
      }
      const rawSettings = localStorage.getItem(SETTINGS_KEY);
      let legacySettings: Partial<typeof defaults> = {};
      if (rawSettings) {
        try { legacySettings = JSON.parse(rawSettings) as Partial<typeof defaults>; } catch { /* use defaults */ }
      }
      const rawMigrationSettings = localStorage.getItem(MIGRATION_SETTINGS_KEY);
      const rawMigrationLiveSettings = localStorage.getItem(MIGRATION_LIVE_SETTINGS_KEY);
      const rawNewPairsSettings = localStorage.getItem(NEW_PAIRS_SETTINGS_KEY);
      try { setMigrationSettings({ ...migrationDefaults, ...(rawMigrationSettings ? JSON.parse(rawMigrationSettings) : {}) }); } catch { /* use migration defaults */ }
      try { setMigrationLiveSettings({ ...migrationLiveDefaults, ...(rawMigrationLiveSettings ? JSON.parse(rawMigrationLiveSettings) : {}) }); } catch { /* use migration live defaults */ }
      try { setNewPairsSettings({ ...defaults, ...(rawNewPairsSettings ? JSON.parse(rawNewPairsSettings) : legacySettings) }); } catch { /* use live defaults */ }
      const rawPositions = localStorage.getItem(POSITIONS_KEY);
      if (rawPositions) {
        try {
          const parsed = JSON.parse(rawPositions) as LivePosition[];
          if (Array.isArray(parsed)) setPositions(parsed.filter((item) => item && item.status !== "closing").map((item) => ({
            ...item,
            entryMarketCapSol: item.entryMarketCapSol ?? item.entryPriceSol * 1_000_000_000,
            currentMarketCapSol: item.currentMarketCapSol ?? item.currentPriceSol * 1_000_000_000,
          })));
        } catch { localStorage.removeItem(POSITIONS_KEY); }
      }
      const rawPnl = localStorage.getItem(PNL_KEY);
      if (rawPnl) {
        try {
          const parsed = JSON.parse(rawPnl) as { date: string; value: number };
          if (parsed.date === new Date().toISOString().slice(0, 10) && Number.isFinite(parsed.value)) setRealizedPnl(parsed.value);
        } catch { localStorage.removeItem(PNL_KEY); }
      }
      const rawSolPrice = Number(localStorage.getItem(SOL_USD_KEY));
      if (Number.isFinite(rawSolPrice) && rawSolPrice > 0) setSolUsdPrice(rawSolPrice);
      const rawStrategyMode = localStorage.getItem(STRATEGY_MODE_KEY);
      if (rawStrategyMode === "new-pairs-live" || rawStrategyMode === "migration-paper" || rawStrategyMode === "migration-live") setStrategyMode(rawStrategyMode);
      const rawPaperPositions = localStorage.getItem(PAPER_POSITIONS_KEY);
      if (rawPaperPositions) {
        try {
          const parsed = JSON.parse(rawPaperPositions) as LivePosition[];
          if (Array.isArray(parsed)) setPaperPositions(parsed.filter((item) => item && item.status !== "closing"));
        } catch { localStorage.removeItem(PAPER_POSITIONS_KEY); }
      }
      const rawPaperAccount = localStorage.getItem(PAPER_ACCOUNT_KEY);
      if (rawPaperAccount) {
        try {
          const parsed = JSON.parse(rawPaperAccount) as { cash: number; realizedPnl: number };
          if (Number.isFinite(parsed.cash) && parsed.cash >= 0) setPaperCash(parsed.cash);
          if (Number.isFinite(parsed.realizedPnl)) setPaperRealizedPnl(parsed.realizedPnl);
        } catch { localStorage.removeItem(PAPER_ACCOUNT_KEY); }
      }
      const rawActivity = localStorage.getItem(ACTIVITY_KEY);
      if (rawActivity) {
        try {
          const parsed = JSON.parse(rawActivity) as ActivityItem[];
          if (Array.isArray(parsed)) setExecutionActivity(parsed.filter((item) => item && typeof item.id === "string" && typeof item.title === "string").slice(0, 30));
        } catch { localStorage.removeItem(ACTIVITY_KEY); }
      }
      setHydrated(true);
    }, 0);
    return () => window.clearTimeout(hydrate);
  }, []);

  const address = storedWallet?.address ?? "";

  useEffect(() => { positionsRef.current = positions; }, [positions]);
  useEffect(() => { paperPositionsRef.current = paperPositions; }, [paperPositions]);
  useEffect(() => { engineModeRef.current = engineMode; }, [engineMode]);
  useEffect(() => { strategyModeRef.current = strategyMode; }, [strategyMode]);
  useEffect(() => { paperCashRef.current = paperCash; }, [paperCash]);
  useEffect(() => { paperRealizedPnlRef.current = paperRealizedPnl; }, [paperRealizedPnl]);
  useEffect(() => { if (hydrated) localStorage.setItem(POSITIONS_KEY, JSON.stringify(positions)); }, [hydrated, positions]);
  useEffect(() => { if (hydrated) localStorage.setItem(PAPER_POSITIONS_KEY, JSON.stringify(paperPositions)); }, [hydrated, paperPositions]);
  useEffect(() => { if (hydrated) localStorage.setItem(PAPER_ACCOUNT_KEY, JSON.stringify({ cash: paperCash, realizedPnl: paperRealizedPnl })); }, [hydrated, paperCash, paperRealizedPnl]);
  useEffect(() => { if (hydrated) localStorage.setItem(ACTIVITY_KEY, JSON.stringify(executionActivity)); }, [executionActivity, hydrated]);
  useEffect(() => { if (hydrated) localStorage.setItem(PNL_KEY, JSON.stringify({ date: new Date().toISOString().slice(0, 10), value: realizedPnl })); }, [hydrated, realizedPnl]);

  const addExecutionActivity = useCallback((title: string, detail: string, tone: "good" | "warn" | "neutral" = "neutral", mint?: string) => {
    setExecutionActivity((current) => [{ id: makeId(), time: Date.now(), title, detail, tone, mint }, ...current].slice(0, 30));
  }, []);

  const refreshBalance = useCallback(async () => {
    if (!address) return;
    setBalanceState("loading");
    try {
      setBalance(await getBalance(address));
      setBalanceError("");
      setBalanceState("ready");
    } catch (cause) {
      setBalanceError(cause instanceof Error ? cause.message : "Balance unavailable");
      setBalanceState("error");
    }
  }, [address]);

  useEffect(() => {
    if (!unlocked || !address) return;
    const initial = window.setTimeout(() => void refreshBalance(), 0);
    const timer = setInterval(() => void refreshBalance(), 12_000);
    return () => { window.clearTimeout(initial); clearInterval(timer); };
  }, [address, refreshBalance, unlocked]);

  useEffect(() => {
    if (!unlocked) return;
    const refresh = async () => {
      try {
        const response = await fetch("/api/sol-price", { cache: "no-store" });
        const payload = await response.json() as { price?: number };
        if (response.ok && Number.isFinite(payload.price) && Number(payload.price) > 0) {
          const price = Number(payload.price);
          setSolUsdPrice(price);
          localStorage.setItem(SOL_USD_KEY, String(price));
        }
      } catch { /* retain the last good conversion rate */ }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 60_000);
    return () => window.clearInterval(timer);
  }, [unlocked]);

  useEffect(() => {
    if (!address) return;
    QRCode.toDataURL(`solana:${address}`, { width: 232, margin: 1, color: { dark: "#07130e", light: "#f1ff8b" } })
      .then(setQr)
      .catch(() => setQr(""));
  }, [address]);

  useEffect(() => {
    const protect = (event: BeforeUnloadEvent) => {
      if (engineMode !== "paused") event.preventDefault();
    };
    window.addEventListener("beforeunload", protect);
    return () => window.removeEventListener("beforeunload", protect);
  }, [engineMode]);

  const saveWallet = async (keypair: Keypair) => {
    if (password.length < 10) throw new Error("Use at least 10 characters for the wallet password");
    if (password !== confirmPassword) throw new Error("Passwords do not match");
    const encrypted = await encryptWallet(keypair.secretKey, password, keypair.publicKey.toBase58());
    localStorage.setItem(STORAGE_KEY, JSON.stringify(encrypted));
    keypairRef.current = keypair;
    setStoredWallet(encrypted);
    setUnlocked(true);
    setPassword("");
    setConfirmPassword("");
    setImportValue("");
  };

  const handleCreate = async () => {
    setBusy(true); setError("");
    try { await saveWallet(Keypair.generate()); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "Could not create wallet"); }
    finally { setBusy(false); }
  };

  const handleImport = async () => {
    setBusy(true); setError("");
    try {
      const backup = parseEncryptedBackup(importValue);
      if (backup) {
        if (password.length < 10) throw new Error("Enter the password used to encrypt this backup");
        if (password !== confirmPassword) throw new Error("Passwords do not match");
        await saveWallet(await decryptWallet(backup, password));
      } else {
        await saveWallet(parseImportedSecret(importValue));
      }
    }
    catch (caught) { setError(caught instanceof Error ? caught.message : "Could not import wallet"); }
    finally { setBusy(false); }
  };

  const handleUnlock = async () => {
    if (!storedWallet) return;
    setBusy(true); setError("");
    try {
      keypairRef.current = await decryptWallet(storedWallet, password);
      setUnlocked(true);
      setPassword("");
    } catch {
      setError("Incorrect password or damaged wallet data");
    } finally { setBusy(false); }
  };

  const lockWallet = () => {
    if (privateKeyClearTimer.current !== null) window.clearTimeout(privateKeyClearTimer.current);
    privateKeyClearTimer.current = null;
    setRevealedPrivateKey("");
    setBackupPassword("");
    setBackupAcknowledged(false);
    setBackupOpen(false);
    keypairRef.current = null;
    setUnlocked(false);
    setEngineMode("paused");
    setOnboarding("unlock");
  };

  const closeLivePosition = useCallback(async (position: LivePosition, reason: string) => {
    if (!keypairRef.current || exitInFlight.current.has(position.id) || liveTradeInFlight.current) return;
    liveTradeInFlight.current = true;
    exitInFlight.current.add(position.id);
    setPositions((current) => current.map((item) => item.id === position.id ? { ...item, status: "closing" } : item));
    addExecutionActivity(`Selling ${position.symbol}`, `${reason} · submitting 100% exit`, "neutral", position.mint);
    try {
      const balanceBefore = await getBalance(keypairRef.current.publicKey.toBase58());
      const sellSlippage = position.source === "migration" ? migrationLiveSettings.exitImpact : newPairsSettings.slippage;
      const signature = await buildSignAndSendTrade({ keypair: keypairRef.current, action: "sell", mint: position.mint, amount: "100%", slippagePercent: sellSlippage, pool: position.source === "migration" ? "pump-amm" : "auto" });
      const balanceAfter = await getChangedBalance(keypairRef.current.publicKey.toBase58(), balanceBefore, "higher");
      const netProceeds = Math.max(0, balanceAfter - balanceBefore);
      const pnl = netProceeds - (position.actualCostSol ?? position.amountSol);
      setRealizedPnl((value) => value + pnl);
      setPositions((current) => current.filter((item) => item.id !== position.id));
      addExecutionActivity(`Sold ${position.symbol}`, `${reason} · ${pnl >= 0 ? "+" : ""}${pnl.toFixed(4)} SOL · ${signature.slice(0, 8)}…`, pnl >= 0 ? "good" : "warn", position.mint);
      void refreshBalance();
    } catch (caught) {
      setPositions((current) => current.map((item) => item.id === position.id ? { ...item, status: "open" } : item));
      addExecutionActivity(`Exit failed: ${position.symbol}`, caught instanceof Error ? caught.message : "Transaction failed", "warn", position.mint);
    } finally {
      exitInFlight.current.delete(position.id);
      liveTradeInFlight.current = false;
    }
  }, [addExecutionActivity, migrationLiveSettings.exitImpact, newPairsSettings.slippage, refreshBalance]);

  const sellLiveMigrationSlice = useCallback(async (position: LivePosition) => {
    if (!keypairRef.current || !position.migrationExitPlan || exitInFlight.current.has(position.id) || liveTradeInFlight.current) return;
    liveTradeInFlight.current = true;
    exitInFlight.current.add(position.id);
    const slicePercent = Math.min(100, Math.max(1, position.migrationExitPlan.slicePercent));
    addExecutionActivity(`Selling ${slicePercent}% remaining: ${position.symbol}`, `Timed migration exit · submitting live mainnet transaction`, "neutral", position.mint);
    try {
      const balanceBefore = await getBalance(keypairRef.current.publicKey.toBase58());
      const signature = await buildSignAndSendTrade({ keypair: keypairRef.current, action: "sell", mint: position.mint, amount: `${slicePercent}%`, slippagePercent: migrationLiveSettings.exitImpact, pool: "pump-amm" });
      const balanceAfter = await getChangedBalance(keypairRef.current.publicKey.toBase58(), balanceBefore, "higher");
      const netProceeds = Math.max(0, balanceAfter - balanceBefore);
      const remainingCost = position.actualCostSol ?? position.amountSol;
      const soldCost = remainingCost * slicePercent / 100;
      const pnl = netProceeds - soldCost;
      const remainingPercent = Math.max(0, position.remainingPercent * (1 - slicePercent / 100));
      const nextPlan = { ...position.migrationExitPlan, slicesCompleted: position.migrationExitPlan.slicesCompleted + 1, nextSliceAt: Date.now() + position.migrationExitPlan.intervalSeconds * 1000 };
      setRealizedPnl((value) => value + pnl);
      setPositions((current) => current.map((item) => item.id === position.id ? { ...item, remainingPercent, actualCostSol: Math.max(0, remainingCost - soldCost), migrationExitPlan: nextPlan } : item));
      addExecutionActivity(`Sold ${slicePercent}% remaining: ${position.symbol}`, `${remainingPercent.toFixed(1)}% of original tokens left · ${pnl >= 0 ? "+" : ""}${pnl.toFixed(4)} SOL · ${signature.slice(0, 8)}…`, pnl >= 0 ? "good" : "warn", position.mint);
      void refreshBalance();
    } catch (caught) {
      addExecutionActivity(`Timed exit failed: ${position.symbol}`, `${caught instanceof Error ? caught.message : "Transaction failed"} · will retry`, "warn", position.mint);
    } finally {
      exitInFlight.current.delete(position.id);
      liveTradeInFlight.current = false;
    }
  }, [addExecutionActivity, migrationLiveSettings.exitImpact, refreshBalance]);

  const handleCandidate = useCallback(async (candidate: LaunchCandidate) => {
    if (!keypairRef.current || entryInFlight.current || liveTradeInFlight.current || positionsRef.current.length >= newPairsSettings.maxPositions) return;
    if (realizedPnl <= -newPairsSettings.dailyLoss) {
      setEngineMode("protect");
      addExecutionActivity("Daily loss limit reached", "New entries disabled; open positions remain protected", "warn");
      return;
    }
    entryInFlight.current = true;
    liveTradeInFlight.current = true;
    const baseAmount = Math.max(0.001, newPairsSettings.buyAmount);
    const adaptiveAmount = Math.max(baseAmount, newPairsSettings.adaptiveBuyAmount);
    addExecutionActivity(`${candidate.symbol} detected`, `Fresh Pump.fun launch · checking live ${adaptiveAmount} SOL impact`, "neutral", candidate.mint);
    let transactionStarted = false;
    try {
      let quote = await fetchLiveBuyQuote(candidate, adaptiveAmount);
      if (Date.now() - quote.quotedAt > LIVE_QUOTE_MAX_AGE_MS) throw new Error("Live quote expired before entry");
      if (quote.impactPercent >= newPairsSettings.maxQuoteImpact && adaptiveAmount > baseAmount) {
        quote = await fetchLiveBuyQuote(candidate, baseAmount);
      }
      if (Date.now() - quote.quotedAt > LIVE_QUOTE_MAX_AGE_MS) throw new Error("Live quote expired before entry");
      if (quote.impactPercent >= newPairsSettings.maxQuoteImpact) {
        addExecutionActivity(`Entry rejected: ${candidate.symbol}`, `${quote.amountSol} SOL live quote shows ${quote.impactPercent.toFixed(1)}% impact · limit is under ${newPairsSettings.maxQuoteImpact}%`, "warn", candidate.mint);
        return;
      }
      const freshBalance = await getBalance(keypairRef.current.publicKey.toBase58());
      if (freshBalance < quote.amountSol + LIVE_WALLET_RESERVE_SOL) {
        setEngineMode("paused");
        addExecutionActivity("Entry blocked", `Wallet needs at least ${(quote.amountSol + LIVE_WALLET_RESERVE_SOL).toFixed(3)} SOL for this quoted order and reserve`, "warn");
        return;
      }
      const balanceBefore = freshBalance;
      transactionStarted = true;
      const signature = await buildSignAndSendTrade({ keypair: keypairRef.current, action: "buy", mint: candidate.mint, amount: quote.amountSol, slippagePercent: newPairsSettings.slippage });
      const balanceAfter = await getChangedBalance(keypairRef.current.publicKey.toBase58(), balanceBefore, "lower");
      const actualCostSol = Math.max(quote.amountSol, balanceBefore - balanceAfter);
      const position: LivePosition = { id: makeId(), mint: candidate.mint, symbol: candidate.symbol.slice(0, 12), name: candidate.name.slice(0, 32), entryPriceSol: candidate.priceSol, currentPriceSol: candidate.priceSol, highPriceSol: candidate.priceSol, entryMarketCapSol: candidate.marketCapSol, currentMarketCapSol: candidate.marketCapSol, entryMarketCapUsd: candidate.marketCapUsd, currentMarketCapUsd: candidate.marketCapUsd, amountSol: quote.amountSol, actualCostSol, remainingPercent: 100, openedAt: Date.now(), buySignature: signature, status: "open", execution: "live", source: "new-token" };
      setPositions((current) => [position, ...current]);
      newPairsEntryFailureStreak.current = 0;
      addExecutionActivity(`Bought ${position.symbol}`, `${quote.amountSol} SOL · ${quote.impactPercent.toFixed(1)}% quoted impact · ${signature.slice(0, 8)}…`, "good", position.mint);
      void refreshBalance();
    } catch (caught) {
      const rawDetail = caught instanceof Error ? caught.message : "Transaction failed";
      const reason = describeLiveEntryFailure(rawDetail);
      if (transactionStarted) {
        newPairsEntryFailureStreak.current += 1;
        const streak = newPairsEntryFailureStreak.current;
        if (streak >= 5) {
          setEngineMode("paused");
          newPairsEntryFailureStreak.current = 0;
          addExecutionActivity(`Entry failed: ${candidate.symbol}`, `${reason} · ${streak} failures in a row, automation paused`, "warn", candidate.mint);
        } else {
          addExecutionActivity(`Entry missed: ${candidate.symbol}`, `${reason} · skipping this coin, still scanning (${streak}/5 recent failures)`, "warn", candidate.mint);
        }
      } else {
        addExecutionActivity(`Entry skipped: ${candidate.symbol}`, `${reason} · no transaction submitted`, "warn", candidate.mint);
      }
    } finally {
      entryInFlight.current = false;
      liveTradeInFlight.current = false;
    }
  }, [addExecutionActivity, newPairsSettings.adaptiveBuyAmount, newPairsSettings.buyAmount, newPairsSettings.dailyLoss, newPairsSettings.maxPositions, newPairsSettings.maxQuoteImpact, newPairsSettings.slippage, realizedPnl, refreshBalance]);

  const closePaperPosition = useCallback((position: LivePosition, reason: string) => {
    if (!paperPositionsRef.current.some((item) => item.id === position.id)) return;
    const ratio = paperMarkRatio(position);
    if (!Number.isFinite(ratio) || ratio <= 0) {
      addExecutionActivity(`Paper exit blocked: ${position.symbol}`, "A trustworthy USD market-cap mark was unavailable", "warn", position.mint);
      return;
    }
    const remainingCapital = position.amountSol * Math.max(0, position.remainingPercent) / 100;
    const grossProceeds = remainingCapital * ratio;
    const quote = executablePaperSellProceeds(grossProceeds, position.currentMarketCapUsd, solUsdPrice, migrationSettings.exitImpact);
    if (!quote.executable) {
      addExecutionActivity(`Paper exit retrying: ${position.symbol}`, `${reason} · estimated ${Number.isFinite(quote.impactPercent) ? quote.impactPercent.toFixed(1) : "unavailable"}% sell impact exceeds ${migrationSettings.exitImpact}% · position remains open`, "warn", position.mint);
      return;
    }
    const proceeds = quote.proceedsSol;
    const pnl = proceeds - remainingCapital;
    const nextCash = paperCashRef.current + proceeds;
    const nextPnl = paperRealizedPnlRef.current + pnl;
    const remaining = paperPositionsRef.current.filter((item) => item.id !== position.id);
    paperCashRef.current = nextCash;
    paperRealizedPnlRef.current = nextPnl;
    paperPositionsRef.current = remaining;
    setPaperCash(nextCash);
    setPaperRealizedPnl(nextPnl);
    setPaperPositions(remaining);
    addExecutionActivity(`Paper exit: ${position.symbol}`, `${reason} · ${formatUsdMarketCap(position.entryMarketCapUsd)} → ${formatUsdMarketCap(position.currentMarketCapUsd)} · ${quote.impactPercent.toFixed(1)}% impact + fees · ${pnl >= 0 ? "+" : ""}${pnl.toFixed(4)} fake SOL`, pnl >= 0 ? "good" : "warn", position.mint);
  }, [addExecutionActivity, migrationSettings.exitImpact, solUsdPrice]);

  const sellPaperSlice = useCallback((position: LivePosition) => {
    if (paperExitInFlight.current.has(position.id)) return;
    paperExitInFlight.current.add(position.id);
    try {
      const current = paperPositionsRef.current.find((item) => item.id === position.id);
      if (!current?.paperExitPlan) return;
      const ratio = paperMarkRatio(current);
      if (!Number.isFinite(ratio) || ratio <= 0) return;
      const slicePercent = Math.min(100, current.paperExitPlan.slicePercent);
      const soldCapital = current.amountSol * current.remainingPercent / 100 * slicePercent / 100;
      const grossProceeds = soldCapital * ratio;
      const quote = executablePaperSellProceeds(grossProceeds, current.currentMarketCapUsd, solUsdPrice, migrationSettings.exitImpact);
      if (!quote.executable) {
        const attemptedAt = Date.now();
        const deferred: LivePosition = {
          ...current,
          paperExitPlan: {
            ...current.paperExitPlan,
            nextSliceAt: attemptedAt + 2_000,
          },
        };
        const deferredPositions = paperPositionsRef.current.map((item) => item.id === current.id ? deferred : item);
        paperPositionsRef.current = deferredPositions;
        setPaperPositions(deferredPositions);
        addExecutionActivity(`Paper slice retrying: ${current.symbol}`, `Estimated ${Number.isFinite(quote.impactPercent) ? quote.impactPercent.toFixed(1) : "unavailable"}% sell impact exceeds ${migrationSettings.exitImpact}% · retrying in 2s`, "warn", current.mint);
        return;
      }
      const proceeds = quote.proceedsSol;
      const pnl = proceeds - soldCapital;
      const remainingPercent = Math.max(0, current.remainingPercent * (1 - slicePercent / 100));
      const slicesCompleted = current.paperExitPlan.slicesCompleted + 1;
      const completedAt = Date.now();
      const nextCash = paperCashRef.current + proceeds;
      const nextPnl = paperRealizedPnlRef.current + pnl;
      const updated: LivePosition = {
        ...current,
        remainingPercent,
        paperExitPlan: {
          ...current.paperExitPlan,
          slicesCompleted,
          nextSliceAt: completedAt + current.paperExitPlan.intervalSeconds * 1000,
        },
      };
      const nextPositions = remainingPercent <= 0.0001
        ? paperPositionsRef.current.filter((item) => item.id !== current.id)
        : paperPositionsRef.current.map((item) => item.id === current.id ? updated : item);
      paperCashRef.current = nextCash;
      paperRealizedPnlRef.current = nextPnl;
      paperPositionsRef.current = nextPositions;
      setPaperCash(nextCash);
      setPaperRealizedPnl(nextPnl);
      setPaperPositions(nextPositions);
      addExecutionActivity(
        remainingPercent <= 0.0001 ? `Paper exit complete: ${current.symbol}` : `Paper sold ${slicePercent}% remaining: ${current.symbol}`,
        `Slice ${slicesCompleted} · ${remainingPercent.toFixed(1)}% of original tokens left · ${formatUsdMarketCap(current.currentMarketCapUsd)} · ${quote.impactPercent.toFixed(1)}% impact + fees · ${pnl >= 0 ? "+" : ""}${pnl.toFixed(4)} fake SOL`,
        pnl >= 0 ? "good" : "warn",
        current.mint,
      );
    } finally {
      paperExitInFlight.current.delete(position.id);
    }
  }, [addExecutionActivity, migrationSettings.exitImpact, solUsdPrice]);

  const handleMigrationCandidate = useCallback(async (unverifiedCandidate: LaunchCandidate, watchTokenTrades: TokenTradeWatcher | null = null) => {
    const migrationMode = strategyModeRef.current;
    if (migrationMode !== "migration-paper" && migrationMode !== "migration-live") return;
    const migrationExecutionSettings = migrationMode === "migration-live" ? migrationLiveSettings : migrationSettings;
    const paperExecution = migrationMode === "migration-paper";
    if (processedMigrationMints.current.has(unverifiedCandidate.mint) || migrationVerificationInFlight.current.has(unverifiedCandidate.mint)) return;
    processedMigrationMints.current.add(unverifiedCandidate.mint);
    migrationVerificationInFlight.current.add(unverifiedCandidate.mint);
    let candidate: LaunchCandidate;
    let migrationAge = 0;
    try {
      const verified = await verifyMigrationCandidate(unverifiedCandidate, MIGRATION_WINDOW_SECONDS);
      candidate = verified.candidate;
      migrationAge = verified.ageSeconds;
    } catch (caught) {
      const reason = caught instanceof Error ? caught.message : "verification failed";
      const candidateLabel = unverifiedCandidate.symbol !== "MIG" ? unverifiedCandidate.symbol : shortAddress(unverifiedCandidate.mint);
      addExecutionActivity(`Migration rejected: ${candidateLabel}`, `${reason} · no ${paperExecution ? "fake" : "live"} entry created`, "warn", unverifiedCandidate.mint);
      processedMigrationMints.current.delete(unverifiedCandidate.mint);
      migrationVerificationInFlight.current.delete(unverifiedCandidate.mint);
      return;
    }
    migrationVerificationInFlight.current.delete(unverifiedCandidate.mint);
    if (migrationWatchInFlight.current.has(candidate.mint) || (paperExecution ? paperPositionsRef.current : positionsRef.current).some((position) => position.mint === candidate.mint)) return;
    migrationWatchInFlight.current.add(candidate.mint);
    const migrationStartedAt = Date.now() - Math.max(0, migrationAge) * 1000;
    const watchDeadline = migrationStartedAt + MIGRATION_WINDOW_SECONDS * 1000;
    const rugTriggerLabel = `${formatUsdMarketCap(migrationExecutionSettings.boostEntryMinMarketCapUsd)}–${formatUsdMarketCap(migrationExecutionSettings.boostEntryMarketCapUsd)}`;
    addExecutionActivity(`${candidate.symbol} BOOST watch`, `${watchTokenTrades ? "Live trades + backup polling" : "Backup polling"} for up to ${Math.max(0, Math.ceil((watchDeadline - Date.now()) / 1000))}s · waiting for the initial rug to enter ${rugTriggerLabel}`, "neutral", candidate.mint);
    let triggerCandidate: LaunchCandidate | null = null;
    let previousObservedMarketCapUsd = Number(candidate.marketCapUsd) > 0
      ? Number(candidate.marketCapUsd)
      : candidate.marketCapSol * solUsdPrice;
    let hasObservedAboveEntryBand = Number.isFinite(previousObservedMarketCapUsd)
      && previousObservedMarketCapUsd > migrationExecutionSettings.boostEntryMarketCapUsd;
    const streamedMarks: LaunchCandidate[] = [];
    let wakeStreamWait: (() => void) | null = null;
    const stopTradeWatch = watchTokenTrades?.(candidate.mint, (mark) => {
      streamedMarks.push(mark);
      wakeStreamWait?.();
    });
    const waitForTradeOrFallback = () => new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        wakeStreamWait = null;
        resolve();
      };
      wakeStreamWait = finish;
      window.setTimeout(finish, MIGRATION_WATCH_POLL_MS);
    });
    while (Date.now() < watchDeadline && engineModeRef.current === "active" && strategyModeRef.current === migrationMode) {
      const streamedMark = streamedMarks.pop();
      if (streamedMark) {
        const streamedMarketCapUsd = Number(streamedMark.marketCapUsd) > 0 ? Number(streamedMark.marketCapUsd) : streamedMark.marketCapSol * solUsdPrice;
        const crossedRugTrigger = Number.isFinite(streamedMarketCapUsd)
          && streamedMarketCapUsd >= migrationExecutionSettings.boostEntryMinMarketCapUsd
          && streamedMarketCapUsd <= migrationExecutionSettings.boostEntryMarketCapUsd
          && hasObservedAboveEntryBand;
        if (streamedMarketCapUsd > migrationExecutionSettings.boostEntryMarketCapUsd) hasObservedAboveEntryBand = true;
        previousObservedMarketCapUsd = streamedMarketCapUsd;
        if (crossedRugTrigger) {
          triggerCandidate = { ...candidate, ...streamedMark, marketCapUsd: streamedMarketCapUsd };
          break;
        }
        continue;
      }
      try {
        const mark = await fetchPumpPrice(candidate.mint);
        const marketCapUsd = Number(mark.marketCapUsd);
        const crossedRugTrigger = Number.isFinite(marketCapUsd)
          && marketCapUsd >= migrationExecutionSettings.boostEntryMinMarketCapUsd
          && marketCapUsd <= migrationExecutionSettings.boostEntryMarketCapUsd
          && hasObservedAboveEntryBand;
        if (marketCapUsd > migrationExecutionSettings.boostEntryMarketCapUsd) hasObservedAboveEntryBand = true;
        if (Number.isFinite(marketCapUsd) && marketCapUsd > 0) previousObservedMarketCapUsd = marketCapUsd;
        if (crossedRugTrigger) {
          triggerCandidate = {
            ...candidate,
            symbol: mark.symbol || candidate.symbol,
            name: mark.name || candidate.name,
            priceSol: mark.priceSol,
            marketCapSol: mark.marketCapSol,
            marketCapUsd,
          };
          break;
        }
      } catch { /* keep watching through transient API failures */ }
      await waitForTradeOrFallback();
    }
    stopTradeWatch?.();
    migrationWatchInFlight.current.delete(candidate.mint);
    if (!triggerCandidate) {
      if (Date.now() >= watchDeadline) {
        addExecutionActivity(`${candidate.symbol} BOOST watch expired`, `The initial rug did not enter ${rugTriggerLabel} during the five-minute window`, "neutral", candidate.mint);
      } else {
        addExecutionActivity(`${candidate.symbol} watch cancelled`, `Automation left the active state mid-watch (mode: ${engineModeRef.current}) · this candidate was dropped`, "warn", candidate.mint);
      }
      return;
    }
    const triggerMarketCapUsd = Number(triggerCandidate.marketCapUsd);
    try {
      const executionMark = await fetchPumpPrice(triggerCandidate.mint);
      candidate = {
        ...triggerCandidate,
        symbol: executionMark.symbol || triggerCandidate.symbol,
        name: executionMark.name || triggerCandidate.name,
        priceSol: executionMark.priceSol,
        marketCapSol: executionMark.marketCapSol,
        marketCapUsd: executionMark.marketCapUsd,
        isMayhemMode: executionMark.isMayhemMode,
        boostMode: executionMark.boostMode,
        isStandardPumpfunMigration: executionMark.isStandardPumpfunMigration,
      };
    } catch {
      addExecutionActivity(`${paperExecution ? "Paper" : "Live"} entry failed: ${triggerCandidate.symbol}`, `Immediate execution quote was unavailable · no ${paperExecution ? "fake" : "live"} fill`, "warn", triggerCandidate.mint);
      return;
    }
    const executionMarketCapUsd = Number(candidate.marketCapUsd);
    if (Date.now() >= watchDeadline) {
      addExecutionActivity(`${paperExecution ? "Paper" : "Live"} entry missed: ${candidate.symbol}`, "The five-minute post-migration window expired before the immediate quote returned", "warn", candidate.mint);
      return;
    }
    if (candidate.isMayhemMode || !candidate.isStandardPumpfunMigration || !candidate.mint.endsWith("pump")) {
      addExecutionActivity(
        `${paperExecution ? "Paper" : "Live"} entry rejected: ${candidate.symbol}`,
        candidate.isMayhemMode
          ? `Mayhem status detected on the immediate entry check · no ${paperExecution ? "fake" : "live"} fill`
          : `Standard Pump.fun migration mode was not confirmed${candidate.boostMode ? ` (${candidate.boostMode})` : ""} · no ${paperExecution ? "fake" : "live"} fill`,
        "warn",
        candidate.mint,
      );
      return;
    }
    if (!Number.isFinite(executionMarketCapUsd) || executionMarketCapUsd < migrationExecutionSettings.boostEntryMinMarketCapUsd || executionMarketCapUsd > migrationExecutionSettings.boostEntryMarketCapUsd) {
      addExecutionActivity(`${paperExecution ? "Paper" : "Live"} entry missed: ${candidate.symbol}`, `After execution latency, market cap moved to ${formatUsdMarketCap(executionMarketCapUsd)} outside ${rugTriggerLabel}`, "warn", candidate.mint);
      return;
    }
    const adverseMovePercent = Math.max(0, (executionMarketCapUsd / triggerMarketCapUsd - 1) * 100);
    const executableBuyAmount = migrationExecutionSettings.buyAmount;
    const impactPercent = estimatedPaperPriceImpactPercent(executableBuyAmount, executionMarketCapUsd, solUsdPrice);
    const totalExecutionSlippage = impactPercent + adverseMovePercent;
    if (!Number.isFinite(totalExecutionSlippage)) {
      addExecutionActivity(
        `${paperExecution ? "Paper" : "Live"} entry rejected: ${candidate.symbol}`,
        `Current MC ${formatUsdMarketCap(executionMarketCapUsd)} · liquidity was unavailable for the fixed ${executableBuyAmount.toFixed(4)} SOL paper order`,
        "warn",
        candidate.mint,
      );
      return;
    }
    const signingKeypair = keypairRef.current;
    if (!signingKeypair) {
      addExecutionActivity(
        `${paperExecution ? "Paper" : "Live"} entry rejected: ${candidate.symbol}`,
        `The wallet was locked before the transaction build · no ${paperExecution ? "fake" : "live"} fill`,
        "warn",
        candidate.mint,
      );
      return;
    }
    const basePosition: LivePosition = {
      id: makeId(),
      mint: candidate.mint,
      symbol: candidate.symbol.slice(0, 12),
      name: candidate.name.slice(0, 32),
      entryPriceSol: candidate.priceSol,
      currentPriceSol: candidate.priceSol,
      highPriceSol: candidate.priceSol,
      entryMarketCapSol: candidate.marketCapSol,
      currentMarketCapSol: candidate.marketCapSol,
      entryMarketCapUsd: candidate.marketCapUsd,
      currentMarketCapUsd: candidate.marketCapUsd,
      amountSol: executableBuyAmount,
      remainingPercent: 100,
      openedAt: Date.now(),
      buySignature: paperExecution ? "paper" : "pending",
      status: "open",
      execution: paperExecution ? "paper" : "live",
      source: "migration",
    };

    if (!paperExecution) {
      if (positionsRef.current.some((position) => position.mint === candidate.mint)) return;
      if (positionsRef.current.length >= migrationExecutionSettings.maxPositions) {
        addExecutionActivity(`${candidate.symbol} migrated`, "Live entry skipped · maximum positions reached", "neutral", candidate.mint);
        return;
      }
      if (realizedPnl <= -migrationExecutionSettings.dailyLoss) {
        setEngineMode("protect");
        addExecutionActivity("Live loss limit reached", "New real-SOL entries disabled; existing positions remain protected", "warn");
        return;
      }
      const freshBalance = await getBalance(signingKeypair.publicKey.toBase58());
      if (freshBalance < executableBuyAmount + LIVE_WALLET_RESERVE_SOL) {
        setEngineMode("paused");
        addExecutionActivity("Live migration entry blocked", `Wallet needs at least ${(executableBuyAmount + LIVE_WALLET_RESERVE_SOL).toFixed(4)} SOL for the order and reserve`, "warn", candidate.mint);
        return;
      }
      liveTradeInFlight.current = true;
      try {
        const balanceBefore = freshBalance;
        const signature = await buildSignAndSendTrade({ keypair: signingKeypair, action: "buy", mint: candidate.mint, amount: executableBuyAmount, slippagePercent: migrationExecutionSettings.slippage, pool: "pump-amm" });
        const balanceAfter = await getChangedBalance(signingKeypair.publicKey.toBase58(), balanceBefore, "lower");
        const actualCostSol = Math.max(executableBuyAmount, balanceBefore - balanceAfter);
        const livePosition: LivePosition = {
          ...basePosition,
          buySignature: signature,
          actualCostSol,
          migrationExitPlan: {
            slicePercent: Math.min(100, Math.max(1, migrationExecutionSettings.boostSellSlicePercent)),
            intervalSeconds: Math.max(1, migrationExecutionSettings.boostSellIntervalSeconds),
            slicesCompleted: 0,
            nextSliceAt: Date.now() + Math.max(1, migrationExecutionSettings.boostSellIntervalSeconds) * 1000,
            expiresAt: watchDeadline,
          },
        };
        setPositions((current) => [livePosition, ...current]);
        migrationEntryFailureStreak.current = 0;
        addExecutionActivity(`Live bought ${livePosition.symbol}`, `${executableBuyAmount.toFixed(4)} SOL · ${formatUsdMarketCap(livePosition.entryMarketCapUsd)} · ${signature.slice(0, 8)}… · BOOST trigger ${Math.max(0, Math.round((Date.now() - migrationStartedAt) / 1000))}s after migration`, "good", livePosition.mint);
        void refreshBalance();
      } catch (error) {
        migrationEntryFailureStreak.current += 1;
        const streak = migrationEntryFailureStreak.current;
        const rawDetail = error instanceof Error ? error.message : "Transaction failed";
        const reason = describeLiveEntryFailure(rawDetail);
        if (streak >= 5) {
          setEngineMode("paused");
          migrationEntryFailureStreak.current = 0;
          addExecutionActivity(`Live entry failed: ${candidate.symbol}`, `${reason} · ${streak} failures in a row, automation paused`, "warn", candidate.mint);
        } else {
          addExecutionActivity(`Live entry missed: ${candidate.symbol}`, `${reason} · skipping this coin, still scanning (${streak}/5 recent failures)`, "warn", candidate.mint);
        }
      } finally {
        liveTradeInFlight.current = false;
      }
      return;
    }

    try {
      await buildExactPaperBuy({ publicKey: signingKeypair.publicKey.toBase58(), mint: candidate.mint, amountSol: executableBuyAmount, slippagePercent: migrationExecutionSettings.slippage });
    } catch (error) {
      addExecutionActivity(`Paper entry rejected: ${candidate.symbol}`, `Exact ${executableBuyAmount.toFixed(4)} SOL transaction could not be built by the live trade route · ${error instanceof Error ? error.message : "unknown execution error"} · no fake fill`, "warn", candidate.mint);
      return;
    }
    if (paperPositionsRef.current.some((position) => position.mint === candidate.mint)) return;
    if (paperPositionsRef.current.length >= migrationExecutionSettings.maxPositions) {
      addExecutionActivity(`${candidate.symbol} migrated`, "Paper entry skipped · maximum positions reached", "neutral", candidate.mint);
      return;
    }
    if (paperRealizedPnlRef.current <= -migrationExecutionSettings.dailyLoss) {
      setEngineMode("protect");
      addExecutionActivity("Paper loss limit reached", "New fake entries disabled; existing paper positions remain protected", "warn");
      return;
    }
    if (paperCashRef.current < executableBuyAmount + PAPER_PRIORITY_FEE_SOL) {
      setEngineMode("paused");
      addExecutionActivity("Paper entry blocked", "Fake SOL balance is too low; reset the paper wallet or reduce order size", "warn");
      return;
    }
    const position: LivePosition = {
      ...basePosition,
      paperInitialTokenValueSol: executableBuyAmount * (1 - PAPER_TRADING_FEE_PERCENT / 100) / (1 + impactPercent / 100),
      paperExitPlan: {
        slicePercent: Math.min(100, Math.max(1, migrationExecutionSettings.boostSellSlicePercent)),
        intervalSeconds: Math.max(1, migrationExecutionSettings.boostSellIntervalSeconds),
        slicesCompleted: 0,
        nextSliceAt: Date.now() + Math.max(1, migrationExecutionSettings.boostSellIntervalSeconds) * 1000,
        expiresAt: watchDeadline,
      },
    };
    const nextCash = paperCashRef.current - executableBuyAmount - PAPER_PRIORITY_FEE_SOL;
    const nextPnl = paperRealizedPnlRef.current - PAPER_PRIORITY_FEE_SOL;
    const nextPositions = [position, ...paperPositionsRef.current];
    paperCashRef.current = nextCash;
    paperRealizedPnlRef.current = nextPnl;
    paperPositionsRef.current = nextPositions;
    setPaperCash(nextCash);
    setPaperRealizedPnl(nextPnl);
    setPaperPositions(nextPositions);
    addExecutionActivity(`Paper bought ${position.symbol}`, `${executableBuyAmount.toFixed(4)} fake SOL exact order · live transaction build passed · ${formatUsdMarketCap(position.entryMarketCapUsd)} · ${totalExecutionSlippage.toFixed(1)}% modeled entry impact + fees · BOOST trigger ${Math.max(0, Math.round((Date.now() - migrationStartedAt) / 1000))}s after migration`, "good", position.mint);
  }, [addExecutionActivity, migrationLiveSettings, migrationSettings, realizedPnl, refreshBalance, solUsdPrice]);

  useEffect(() => {
    if (!unlocked || engineMode !== "active") return;
    if (strategyMode === "migration-paper" || strategyMode === "migration-live") return openMigrationFeed((candidate, watchTokenTrades) => void handleMigrationCandidate(candidate, watchTokenTrades), setFeedStatus);
    return openLaunchFeed((candidate) => void handleCandidate(candidate), setFeedStatus);
  }, [engineMode, handleCandidate, handleMigrationCandidate, strategyMode, unlocked]);

  useEffect(() => {
    if (!unlocked || positions.length === 0) return;
    const poll = async () => {
      for (const position of positionsRef.current) {
        if (position.status !== "open") continue;
        try {
          const mark = await fetchPumpPrice(position.mint);
          const updated = { ...position, symbol: mark.symbol?.slice(0, 12) ?? position.symbol, name: mark.name?.slice(0, 32) ?? position.name, currentPriceSol: mark.priceSol, highPriceSol: Math.max(position.highPriceSol, mark.priceSol), currentMarketCapSol: mark.marketCapSol, currentMarketCapUsd: mark.marketCapUsd };
          setPositions((current) => current.map((item) => item.id === position.id ? updated : item));
          const change = (mark.priceSol / position.entryPriceSol - 1) * 100;
          const age = (Date.now() - position.openedAt) / 1000;
          if (engineMode === "paused") continue;
          if (position.source === "migration" && position.migrationExitPlan) {
            if (change >= migrationLiveSettings.takeProfit) void closeLivePosition(updated, `+${migrationLiveSettings.takeProfit}% target reached`);
            else if (Date.now() >= position.migrationExitPlan.expiresAt) void closeLivePosition(updated, "Five-minute migration window ended");
            else if (Date.now() >= position.migrationExitPlan.nextSliceAt) void sellLiveMigrationSlice(updated);
            continue;
          }
          if (change <= -newPairsSettings.stopLoss) void closeLivePosition(updated, "Stop loss");
          else if (change >= newPairsSettings.takeProfit) void closeLivePosition(updated, "Take profit");
          else if (age >= newPairsSettings.maxHold) void closeLivePosition(updated, "Time exit");
        } catch { /* retain the previous mark during a transient failure */ }
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 2_000);
    return () => window.clearInterval(timer);
  }, [closeLivePosition, engineMode, migrationLiveSettings.takeProfit, newPairsSettings.maxHold, newPairsSettings.stopLoss, newPairsSettings.takeProfit, positions.length, sellLiveMigrationSlice, unlocked]);

  useEffect(() => {
    if (!unlocked || paperPositions.length === 0) return;
    const poll = async () => {
      if (paperPollInFlight.current) return;
      paperPollInFlight.current = true;
      try {
        for (const position of paperPositionsRef.current) {
          try {
          let mark = await fetchPumpPrice(position.mint);
          const previousMarketCapUsd = Number(position.currentMarketCapUsd);
          const nextMarketCapUsd = Number(mark.marketCapUsd);
          if (!Number.isFinite(nextMarketCapUsd) || nextMarketCapUsd <= 0) continue;
          const markJump = Number.isFinite(previousMarketCapUsd) && previousMarketCapUsd > 0 ? nextMarketCapUsd / previousMarketCapUsd : 1;
          if (markJump > 5 || markJump < 0.2) {
            await new Promise((resolve) => window.setTimeout(resolve, 350));
            const confirmation = await fetchPumpPrice(position.mint);
            const confirmedMarketCapUsd = Number(confirmation.marketCapUsd);
            const confirmationRatio = confirmedMarketCapUsd / nextMarketCapUsd;
            if (!Number.isFinite(confirmedMarketCapUsd) || confirmedMarketCapUsd <= 0 || confirmationRatio < 0.8 || confirmationRatio > 1.25) {
              if (!unstableMarkWarnings.current.has(position.mint)) {
                unstableMarkWarnings.current.add(position.mint);
                addExecutionActivity(`Unstable mark ignored: ${position.symbol}`, "Conflicting USD market-cap readings · position unchanged", "warn", position.mint);
              }
              continue;
            }
            mark = confirmation;
          }
          unstableMarkWarnings.current.delete(position.mint);
          const latest = paperPositionsRef.current.find((item) => item.id === position.id);
          if (!latest) continue;
          const updated = { ...latest, symbol: mark.symbol?.slice(0, 12) ?? latest.symbol, name: mark.name?.slice(0, 32) ?? latest.name, currentPriceSol: mark.priceSol, highPriceSol: Math.max(latest.highPriceSol, mark.priceSol), currentMarketCapSol: mark.marketCapSol, currentMarketCapUsd: mark.marketCapUsd };
          const nextPositions = paperPositionsRef.current.map((item) => item.id === position.id ? updated : item);
          paperPositionsRef.current = nextPositions;
          setPaperPositions(nextPositions);
          const ratio = paperMarkRatio(updated);
          if (!Number.isFinite(ratio) || ratio <= 0) continue;
          const change = (ratio - 1) * 100;
          if (engineMode === "paused") continue;
          if (change >= migrationSettings.takeProfit) closePaperPosition(updated, `+${migrationSettings.takeProfit}% target reached`);
          else if (updated.paperExitPlan?.expiresAt && Date.now() >= updated.paperExitPlan.expiresAt) closePaperPosition(updated, "Five-minute BOOST window ended");
          else if (updated.paperExitPlan && Date.now() >= updated.paperExitPlan.nextSliceAt) sellPaperSlice(updated);
          } catch { /* retain the previous real market mark */ }
        }
      } finally {
        paperPollInFlight.current = false;
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 1_000);
    return () => window.clearInterval(timer);
  }, [addExecutionActivity, closePaperPosition, engineMode, migrationSettings.takeProfit, paperPositions.length, sellPaperSlice, unlocked]);

  const copyAddress = async () => {
    await navigator.clipboard.writeText(address);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  const downloadBackup = () => {
    if (!storedWallet) return;
    const blob = new Blob([JSON.stringify(storedWallet, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `lockstep-${storedWallet.address.slice(0, 6)}.lockstep.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    addExecutionActivity("Encrypted backup exported", "Store it privately; the wallet password is required to unlock it", "good");
  };

  const closeBackup = () => {
    if (privateKeyClearTimer.current !== null) window.clearTimeout(privateKeyClearTimer.current);
    privateKeyClearTimer.current = null;
    setBackupOpen(false);
    setBackupPassword("");
    setBackupAcknowledged(false);
    setBackupError("");
    setBackupBusy(false);
    setRevealedPrivateKey("");
    setPrivateKeyVisible(false);
    setPrivateKeyCopied(false);
  };

  const revealPrivateKey = async () => {
    if (!storedWallet) return;
    setBackupError("");
    if (!backupAcknowledged) {
      setBackupError("Confirm that you understand the private-key warning first");
      return;
    }
    if (!backupPassword) {
      setBackupError("Enter the wallet password used to encrypt this backup");
      return;
    }
    setBackupBusy(true);
    try {
      const keypair = await decryptWallet(storedWallet, backupPassword);
      const privateKey = bs58.encode(keypair.secretKey);
      setRevealedPrivateKey(privateKey);
      setBackupPassword("");
      setPrivateKeyVisible(false);
      setPrivateKeyCopied(false);
      if (privateKeyClearTimer.current !== null) window.clearTimeout(privateKeyClearTimer.current);
      privateKeyClearTimer.current = window.setTimeout(() => {
        setRevealedPrivateKey("");
        setPrivateKeyVisible(false);
        setPrivateKeyCopied(false);
        privateKeyClearTimer.current = null;
      }, 30_000);
    } catch {
      setBackupError("Incorrect password or damaged wallet data");
    } finally {
      setBackupBusy(false);
    }
  };

  const copyPrivateKey = async () => {
    if (!revealedPrivateKey) return;
    try {
      await navigator.clipboard.writeText(revealedPrivateKey);
      setPrivateKeyCopied(true);
      window.setTimeout(() => setPrivateKeyCopied(false), 1800);
    } catch {
      setBackupError("Clipboard access was blocked. Select and copy the key manually.");
    }
  };

  const uploadKeypair = async (file?: File) => {
    if (!file) return;
    setImportValue(await file.text());
  };

  const requestActivation = () => {
    if (strategyMode === "migration-paper") {
      setEngineMode("active");
      addExecutionActivity("Migration paper mode active", "Fresh standard Pump.fun migrations only · Mayhem and other launchpads excluded · no transactions can be signed", "good");
      return;
    }
    if (balanceState !== "ready") {
      addExecutionActivity("Activation blocked", "Wait for Lockstep to confirm the wallet balance on Solana mainnet", "warn");
      void refreshBalance();
      return;
    }
    const liveOrderAmount = strategyMode === "migration-live" ? migrationLiveSettings.buyAmount : Math.max(newPairsSettings.buyAmount, newPairsSettings.adaptiveBuyAmount);
    const required = liveOrderAmount + LIVE_WALLET_RESERVE_SOL;
    if (balance < required) {
      addExecutionActivity("Activation blocked", `Deposit at least ${required.toFixed(4)} SOL for one order and the wallet reserve`, "warn");
      return;
    }
    setActivationOpen(true);
  };

  const trackedTokenValue = positions.reduce((sum, position) => sum + position.amountSol * Math.max(0, position.remainingPercent) / 100 * (position.currentPriceSol / position.entryPriceSol), 0);
  const unrealizedPnl = positions.reduce((sum, position) => sum + position.amountSol * Math.max(0, position.remainingPercent) / 100 * (position.currentPriceSol / position.entryPriceSol - 1), 0);
  const openExposure = positions.reduce((sum, position) => sum + position.amountSol * Math.max(0, position.remainingPercent) / 100, 0);
  const paperTokenValue = paperPositions.reduce((sum, position) => {
    const ratio = paperMarkRatio(position);
    const remainingFraction = Math.max(0, position.remainingPercent) / 100;
    return sum + (Number.isFinite(ratio) && ratio > 0 ? position.amountSol * remainingFraction * ratio : position.amountSol * remainingFraction);
  }, 0);
  const paperUnrealizedPnl = paperPositions.reduce((sum, position) => {
    const ratio = paperMarkRatio(position);
    return sum + (Number.isFinite(ratio) && ratio > 0 ? position.amountSol * Math.max(0, position.remainingPercent) / 100 * (ratio - 1) : 0);
  }, 0);
  const paperOpenExposure = paperPositions.reduce((sum, position) => sum + position.amountSol * Math.max(0, position.remainingPercent) / 100, 0);
  const visiblePositions = strategyMode === "migration-paper" ? paperPositions : positions;
  const paperMode = strategyMode === "migration-paper";
  const migrationLiveMode = strategyMode === "migration-live";
  const migrationDisplaySettings = paperMode ? migrationSettings : migrationLiveSettings;

  const changeStrategy = (next: StrategyMode) => {
    setEngineMode("paused");
    setStrategyMode(next);
    localStorage.setItem(STRATEGY_MODE_KEY, next);
    const label = next === "migration-paper" ? "Migration Paper Lab selected" : next === "migration-live" ? "Migration Live selected" : "New Pairs Live selected";
    const detail = next === "migration-paper" ? "Isolated fake SOL testing; cannot sign transactions" : "Uses real SOL from the unlocked wallet; activation is required";
    addExecutionActivity(label, detail, "neutral");
  };

  const resetPaperWallet = () => {
    setEngineMode("paused");
    paperPositionsRef.current = [];
    paperCashRef.current = migrationSettings.paperStartingBalance;
    paperRealizedPnlRef.current = 0;
    setPaperPositions([]);
    setPaperCash(migrationSettings.paperStartingBalance);
    setPaperRealizedPnl(0);
    addExecutionActivity("Paper wallet reset", `${migrationSettings.paperStartingBalance.toFixed(2)} fake SOL available`, "good");
  };

  const activity = useMemo(() => [
    ...executionActivity.map((item) => ({ id: item.id, time: new Date(item.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }), title: item.title, detail: item.detail, tone: item.tone, mint: item.mint })),
    { id: "wallet-state", time: "Now", title: unlocked ? "Wallet unlocked" : "Wallet locked", detail: unlocked ? "Signing key is available only in this browser session" : "Automation cannot sign transactions", tone: unlocked ? "good" : "warn", mint: undefined },
    { id: "encrypted-vault", time: "Local", title: "Encrypted vault", detail: "Private key ciphertext is stored on this device", tone: "good", mint: undefined },
    { id: "network-state", time: "Mainnet", title: balanceState === "error" ? "Balance unavailable" : "Network ready", detail: balanceState === "ready" ? `Confirmed balance: ${balance.toFixed(4)} SOL` : balanceState === "error" ? balanceError : "Waiting for wallet balance", tone: balanceState === "error" ? "warn" : "neutral", mint: undefined },
  ], [balance, balanceError, balanceState, executionActivity, unlocked]);

  if (!unlocked) {
    return (
      <main className="onboarding-shell">
        <header className="public-nav">
          <Brand />
          <div className="network-pill"><i /> SOLANA MAINNET</div>
        </header>
        <section className="onboarding-grid">
          <div className="onboarding-copy">
            <div className="eyebrow"><span>01</span> LOCAL WALLET SECURITY</div>
            <h1>Your sniper.<br /><em>Your keys.</em></h1>
            <p>Create or import a dedicated Solana trading wallet. Lockstep encrypts it in your browser and runs only while you keep the session open.</p>
            <div className="trust-strip">
              <span><i>✓</i> Encrypted locally</span>
              <span><i>✓</i> No seed phrase required</span>
              <span><i>✓</i> Stops when closed</span>
            </div>
          </div>
          <div className="onboarding-card">
            {onboarding === "choose" && (
              <>
                <div className="step-kicker">GET STARTED</div>
                <h2>Choose your wallet</h2>
                <p className="muted">Use a dedicated, low-balance wallet for automated trading.</p>
                <button className="choice-card recommended" onClick={() => { setOnboarding("create"); setError(""); }}>
                  <span className="choice-icon">＋</span><span><b>Create Lockstep wallet</b><small>New wallet generated on this device</small></span><em>RECOMMENDED</em>
                </button>
                <button className="choice-card" onClick={() => { setOnboarding("import"); setError(""); }}>
                  <span className="choice-icon">↳</span><span><b>Import trading wallet</b><small>Private key, keypair JSON, or Lockstep backup</small></span><strong>→</strong>
                </button>
                <SecurityNote />
              </>
            )}
            {onboarding === "create" && (
              <WalletPasswordForm title="Protect your new wallet" description="This password encrypts the wallet on this device." password={password} confirmPassword={confirmPassword} setPassword={setPassword} setConfirmPassword={setConfirmPassword} error={error} busy={busy} submitLabel="Create wallet" onSubmit={handleCreate} onBack={() => setOnboarding("choose")} />
            )}
            {onboarding === "import" && (
              <>
                <button className="back-button" onClick={() => setOnboarding("choose")}>← Back</button>
                <div className="step-kicker">IMPORT WALLET</div>
                <h2>Bring a trading wallet</h2>
                <p className="muted">Import a burner wallet or restore an encrypted Lockstep backup—not the wallet holding your main assets.</p>
                <label className="field-label">PRIVATE KEY OR WALLET FILE<textarea value={importValue} onChange={(event) => setImportValue(event.target.value)} placeholder="Paste base58 key or [12, 44, 91, ...]" autoComplete="off" spellCheck={false} /></label>
                <label className="upload-button">Upload wallet file<input type="file" accept=".json,.lockstep,application/json" onChange={(event) => void uploadKeypair(event.target.files?.[0])} /></label>
                <WalletPasswordFields password={password} confirmPassword={confirmPassword} setPassword={setPassword} setConfirmPassword={setConfirmPassword} />
                {error && <p className="form-error">{error}</p>}
                <button className="primary-button" disabled={busy} onClick={() => void handleImport()}>{busy ? "Encrypting…" : "Encrypt & import"}</button>
              </>
            )}
            {onboarding === "unlock" && storedWallet && (
              <>
                <div className="step-kicker">WELCOME BACK</div>
                <h2>Unlock Lockstep</h2>
                <div className="wallet-preview"><span>LS</span><div><small>TRADING WALLET</small><b>{shortAddress(storedWallet.address)}</b></div><i>LOCKED</i></div>
                <label className="field-label">WALLET PASSWORD<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} onKeyDown={(event) => event.key === "Enter" && void handleUnlock()} placeholder="Enter your password" autoFocus /></label>
                {error && <p className="form-error">{error}</p>}
                <button className="primary-button" disabled={busy} onClick={() => void handleUnlock()}>{busy ? "Unlocking…" : "Unlock wallet"}</button>
                <p className="local-only">The decrypted key stays in memory until you lock or close Lockstep.</p>
              </>
            )}
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className="dashboard-shell">
      <header className="app-nav">
        <Brand />
        <div className="app-nav-actions">
          <span className={`network-pill ${paperMode ? "paper-network" : ""}`}><i /> {paperMode ? "PAPER LAB · LIVE DATA" : "MAINNET · REAL SOL"}</span>
          <button className="wallet-chip" onClick={copyAddress}><span>LS</span><b>{shortAddress(address)}</b><small>{copied ? "COPIED" : "COPY"}</small></button>
          <button className="lock-button" onClick={() => setBackupOpen(true)}>Backup</button>
          <button className="lock-button" onClick={lockWallet}>Lock</button>
        </div>
      </header>
      <div className="dashboard-content">
        <section className="engine-bar panel">
          <div><div className={`engine-orb ${engineMode}`}><i /></div><span><small>ENGINE STATE</small><b>{engineMode === "active" ? paperMode ? "Paper migration lab active" : migrationLiveMode ? "Migration Live active" : "New Pairs Live active" : engineMode === "protect" ? "Protecting positions" : "Ready, fully paused"}</b><p>{engineMode === "active" ? paperMode ? "Real migration data, fake SOL only. This lab cannot sign transactions." : "Real mainnet buys and exits run only while this tab stays open and unlocked." : "No automatic orders can be submitted."}</p></span></div>
          <div className="mode-tabs">
            <button className={engineMode === "active" ? "selected" : ""} onClick={requestActivation}><i>▶</i><span><b>Active</b><small>{engineMode === "active" && feedStatus === "live" ? strategyMode === "new-pairs-live" ? "Live launch feed" : "Live migration feed" : "Scan, enter & exit"}</small></span></button>
            <button className={engineMode === "protect" ? "selected" : ""} onClick={() => setEngineMode("protect")}><i>◇</i><span><b>Protect only</b><small>Exit management</small></span></button>
            <button className={engineMode === "paused" ? "selected" : ""} onClick={() => setEngineMode("paused")}><i>Ⅱ</i><span><b>Paused</b><small>Stop automation</small></span></button>
          </div>
        </section>

        <section className="metric-grid">
          <Metric label={paperMode ? "PAPER PORTFOLIO" : "PORTFOLIO VALUE"} value={paperMode ? `${(paperCash + paperTokenValue).toFixed(4)} fake SOL` : balanceState === "ready" ? `${(balance + trackedTokenValue).toFixed(4)} SOL` : "— SOL"} detail={paperMode ? "Fake cash + real marked token value" : balanceState === "error" ? "Balance connection unavailable" : "SOL + tracked token value"} accent />
          <Metric label={paperMode ? "PAPER CASH" : "AVAILABLE BALANCE"} value={paperMode ? `${paperCash.toFixed(4)} fake SOL` : balanceState === "loading" ? "Refreshing…" : balanceState === "error" ? "Unavailable" : balanceState === "ready" ? `${balance.toFixed(4)} SOL` : "— SOL"} detail={paperMode ? "No real funds used" : balanceState === "error" ? "Could not reach Solana mainnet" : "Confirmed on Solana mainnet"} />
          <Metric label="OPEN EXPOSURE" value={`${(paperMode ? paperOpenExposure : openExposure).toFixed(4)} ${paperMode ? "fake SOL" : "SOL"}`} detail={`${visiblePositions.length} of ${activeSettings.maxPositions} positions`} />
          <Metric label="SESSION RESULT" value={`${paperMode ? paperRealizedPnl + paperUnrealizedPnl >= 0 ? "+" : "" : realizedPnl + unrealizedPnl >= 0 ? "+" : ""}${(paperMode ? paperRealizedPnl + paperUnrealizedPnl : realizedPnl + unrealizedPnl).toFixed(4)} ${paperMode ? "fake SOL" : "SOL"}`} detail="Realized + marked P&L" />
        </section>

        <section className="main-grid">
          {paperMode ? <article className="panel deposit-panel paper-lab-panel">
            <div className="panel-heading"><div><small>LIVE DATA LAB</small><h2>Real migrations, fake execution</h2></div><span className="live-badge"><i /> PUMPPORTAL</span></div>
            <div className="paper-lab-content"><div className="paper-balance-block"><small>PAPER WALLET</small><b>{paperCash.toFixed(4)} <em>fake SOL</em></b><span>Never touches your deposited SOL</span></div><div className="paper-lab-copy"><p>Lockstep listens for fresh standard Pump.fun migrations, excludes Mayhem and other launchpads, then watches their five-minute post-migration window and models whether your configured SOL order could actually fill after price impact and fees.</p><div className="paper-steps"><span><i>01</i> Standard migration verified</span><span><i>02</i> Executable fill checked</span><span><i>03</i> Realistic exits tracked</span></div><div className="deposit-warning"><b>Real-SOL mentality, fake-SOL safety.</b><span>Impossible entries and exits are rejected instead of being counted as paper profit.</span></div></div></div>
          </article> : <article className="panel deposit-panel">
            <div className="panel-heading"><div><small>FUNDING</small><h2>Deposit SOL</h2></div><span className={`live-badge ${balanceState === "error" ? "balance-error" : ""}`}><i /> {balanceState === "error" ? "BALANCE ERROR" : balanceState === "loading" ? "REFRESHING" : "LIVE BALANCE"}</span></div>
            <div className="deposit-content">
              <div className="qr-frame">{qr ? <>{/* QR is generated locally as a data URL. */}<img src={qr} alt="Solana deposit QR code" /></> : <span>Generating QR…</span>}</div>
              <div className="deposit-details"><p>Send SOL to this dedicated Lockstep wallet from Phantom, an exchange, or another Solana wallet.</p><label>WALLET ADDRESS<div className="address-box"><code>{address}</code><button onClick={copyAddress}>{copied ? "Copied" : "Copy"}</button></div></label>{balanceState === "error" ? <div className="balance-alert"><b>Balance has not been verified yet.</b><span>{balanceError}. Your funds remain in the wallet; try refresh again.</span></div> : <div className="deposit-warning"><b>Only send assets on Solana.</b><span>Start with a small amount. Lockstep cannot recover funds sent through another network.</span></div>}<button className="refresh-button" disabled={balanceState === "loading"} onClick={() => void refreshBalance()}>↻ {balanceState === "loading" ? "Refreshing…" : "Refresh balance"}</button></div>
            </div>
          </article>}

          <aside className="panel strategy-panel">
            <div className="panel-heading"><div><small>STRATEGY</small><h2>{paperMode ? "Migration Paper Lab" : migrationLiveMode ? "Migration Live" : "New Pairs Live"}</h2></div><button className="text-button" onClick={() => setSettingsOpen(true)}>EDIT</button></div>
            <div className="strategy-switch" role="group" aria-label="Trading strategy"><button className={migrationLiveMode ? "selected danger-edge" : ""} onClick={() => changeStrategy("migration-live")}><b>Migration Live</b><small>Real feed · real SOL</small></button><button className={strategyMode === "new-pairs-live" ? "selected danger-edge" : ""} onClick={() => changeStrategy("new-pairs-live")}><b>New Pairs Live</b><small>Real feed · real SOL</small></button><button className={paperMode ? "selected paper-choice" : "paper-choice"} onClick={() => changeStrategy("migration-paper")}><b>Paper Lab</b><small>Fake SOL · isolated</small></button></div>
            <div className="order-size"><span>{paperMode ? "PAPER ORDER SIZE" : "REAL ORDER SIZE"}</span><b>{strategyMode === "new-pairs-live" ? `${newPairsSettings.buyAmount} → ${newPairsSettings.adaptiveBuyAmount}` : `${activeSettings.buyAmount}`} <small>{paperMode ? "FAKE SOL" : "SOL"}</small></b></div>
            <div className="strategy-rules"><Rule label="Max positions" value={String(activeSettings.maxPositions)} /><Rule label="Daily loss limit" value={`${activeSettings.dailyLoss} ${paperMode ? "fake SOL" : "SOL"}`} danger />{strategyMode !== "new-pairs-live" ? <><Rule label="Initial-rug entry" value={`${formatUsdMarketCap(migrationDisplaySettings.boostEntryMinMarketCapUsd)}–${formatUsdMarketCap(migrationDisplaySettings.boostEntryMarketCapUsd)}`} good /><Rule label={paperMode ? "Exact paper order" : "Exact live order"} value={`${migrationDisplaySettings.buyAmount} ${paperMode ? "fake SOL" : "SOL"}`} danger /><Rule label="Buy slippage" value={`${migrationDisplaySettings.slippage}%`} danger /><Rule label="Sell slippage" value={`${migrationDisplaySettings.exitImpact}%`} danger /><Rule label="Timed sell" value={`${migrationDisplaySettings.boostSellSlicePercent}% remaining every ${migrationDisplaySettings.boostSellIntervalSeconds}s`} /><Rule label="Profit exit" value={`+${migrationDisplaySettings.takeProfit}% · sell all`} good /><Rule label="Hard exit" value="5 min after migration" /></> : <><Rule label="Stop loss" value={`−${activeSettings.stopLoss}%`} danger /><Rule label="Quote-up size" value={`${newPairsSettings.adaptiveBuyAmount} SOL`} good /><Rule label="Live impact gate" value={`<${newPairsSettings.maxQuoteImpact}%`} /><Rule label="Take profit" value={`+${activeSettings.takeProfit}%`} good /><Rule label="Maximum hold" value={`${activeSettings.maxHold}s`} /><Rule label="Transaction slippage" value={`${activeSettings.slippage}%`} /></>}</div>
            <div className="browser-note"><i>◉</i><span><b>{paperMode ? "Isolated paper execution" : "Browser-bound real execution"}</b><small>{paperMode ? "No code path in this lab can sign or submit a transaction." : "Keep this tab open and wallet unlocked. Live activation is always confirmed separately."}</small></span></div>
            {paperMode && <button className="refresh-button" onClick={resetPaperWallet}>↻ Reset paper wallet to {migrationSettings.paperStartingBalance.toFixed(2)} fake SOL</button>}
          </aside>
        </section>

        <section className="panel positions-panel">
          <div className="panel-heading"><div><small>{paperMode ? "PAPER PORTFOLIO" : "PORTFOLIO"}</small><h2>Open positions</h2></div><span className="count-badge">{visiblePositions.length} ACTIVE</span></div>
          <div className="positions-head"><span>ASSET</span><span>ENTRY MC</span><span>MARK MC</span><span>RETURN</span><span>SIZE</span><span>STATUS</span></div>
          {visiblePositions.length === 0 ? <div className="empty-positions"><span>◇</span><b>{paperMode ? "No fake capital deployed" : "No capital deployed"}</b><p>{engineMode === "active" ? paperMode ? "Waiting for the next real PumpPortal migration." : "Waiting for a live candidate to pass your rules." : "Activate the engine when you are ready to begin."}</p></div> : <div className="position-list">{visiblePositions.map((position) => {
            const paperRatio = paperMarkRatio(position);
            const change = paperMode && Number.isFinite(paperRatio) ? (paperRatio - 1) * 100 : (position.currentPriceSol / position.entryPriceSol - 1) * 100;
            const entryMarketCap = position.entryMarketCapSol ?? position.entryPriceSol * 1_000_000_000;
            const currentMarketCap = position.currentMarketCapSol ?? position.currentPriceSol * 1_000_000_000;
            const displayName = position.name || position.symbol;
            return <div className="position-row" key={position.id}><div className="position-asset"><span>{displayName.slice(0, 2)}</span><div><b>{displayName}</b>{position.name && position.symbol !== position.name && <small>${position.symbol}</small>}<a href={`https://pump.fun/coin/${position.mint}`} target="_blank" rel="noreferrer">{shortAddress(position.mint)} ↗</a></div></div><code>{formatMarketCap(entryMarketCap, solUsdPrice, position.entryMarketCapUsd)}</code><code>{formatMarketCap(currentMarketCap, solUsdPrice, position.currentMarketCapUsd)}</code><b className={change >= 0 ? "good" : "danger"}>{change >= 0 ? "+" : ""}{change.toFixed(1)}%</b><span>{(position.amountSol * Math.max(0, position.remainingPercent) / 100).toFixed(3)} {paperMode ? "fake SOL" : "SOL"}</span><button disabled={position.status === "closing"} onClick={() => paperMode ? closePaperPosition(position, "Manual exit") : void closeLivePosition(position, "Manual exit")}>{position.status === "closing" ? "SELLING" : "EXIT"}</button></div>;
          })}</div>}
        </section>

        <section className="panel activity-panel">
          <div className="panel-heading"><div><small>SECURITY & ACTIVITY</small><h2>Session receipts</h2></div><span className="session-pill">THIS DEVICE</span></div>
          {activity.map((item) => <div className="activity-row" key={item.id}><time>{item.time}</time><i className={item.tone} />{item.mint ? <a className="activity-asset-link" href={`https://pump.fun/coin/${item.mint}`} target="_blank" rel="noreferrer" title="Open coin on Pump.fun">{item.title} ↗</a> : <b>{item.title}</b>}<p>{item.detail}</p><span>{item.tone === "good" ? "READY" : item.tone === "warn" ? "LOCKED" : "INFO"}</span></div>)}
        </section>
      </div>

      {settingsOpen && <SettingsDrawer initialMode={strategyMode} migrationSettings={migrationSettings} migrationLiveSettings={migrationLiveSettings} newPairsSettings={newPairsSettings} onClose={() => setSettingsOpen(false)} onSave={(nextMigration, nextMigrationLive, nextNewPairs) => { setMigrationSettings(nextMigration); setMigrationLiveSettings(nextMigrationLive); setNewPairsSettings(nextNewPairs); localStorage.setItem(MIGRATION_SETTINGS_KEY, JSON.stringify(nextMigration)); localStorage.setItem(MIGRATION_LIVE_SETTINGS_KEY, JSON.stringify(nextMigrationLive)); localStorage.setItem(NEW_PAIRS_SETTINGS_KEY, JSON.stringify(nextNewPairs)); setSettingsOpen(false); }} />}
      {backupOpen && <div className="backup-backdrop" onMouseDown={(event) => event.target === event.currentTarget && closeBackup()}>
        <section className="backup-modal" role="dialog" aria-modal="true" aria-labelledby="wallet-backup-title">
          <div className="backup-heading"><div><small>WALLET SECURITY</small><h2 id="wallet-backup-title">Wallet backup</h2></div><button aria-label="Close wallet backup" onClick={closeBackup}>×</button></div>
          <p>Your encrypted backup is the safest file to store. It cannot unlock the wallet without your password.</p>
          <button className="secondary-button backup-download" onClick={downloadBackup}>Download encrypted backup</button>
          <div className="private-key-panel">
            <span className="danger-kicker">DANGEROUS</span>
            <h3>Reveal private key</h3>
            <p>Anyone who sees this key can take every asset in this wallet. Lockstep decrypts it only in this browser and clears it after 30 seconds.</p>
            {!revealedPrivateKey ? <>
              <label className="field-label">WALLET PASSWORD<input type="password" value={backupPassword} onChange={(event) => setBackupPassword(event.target.value)} onKeyDown={(event) => event.key === "Enter" && void revealPrivateKey()} placeholder="Enter your wallet password" autoComplete="current-password" /></label>
              <label className="backup-confirm"><input type="checkbox" checked={backupAcknowledged} onChange={(event) => setBackupAcknowledged(event.target.checked)} /><span>I understand anyone with this private key controls the wallet.</span></label>
              {backupError && <p className="form-error">{backupError}</p>}
              <button className="danger-button" disabled={backupBusy || !backupAcknowledged} onClick={() => void revealPrivateKey()}>{backupBusy ? "Decrypting…" : "Reveal private key"}</button>
            </> : <>
              <label className="field-label">BASE58 PRIVATE KEY<div className="revealed-key"><input readOnly type={privateKeyVisible ? "text" : "password"} value={revealedPrivateKey} aria-label="Base58 private key" /><button onClick={() => setPrivateKeyVisible((visible) => !visible)}>{privateKeyVisible ? "Hide" : "Show"}</button></div></label>
              <div className="private-key-actions"><button className="secondary-button" onClick={() => void copyPrivateKey()}>{privateKeyCopied ? "Copied" : "Copy private key"}</button><button className="secondary-button" onClick={() => { setRevealedPrivateKey(""); setPrivateKeyVisible(false); setPrivateKeyCopied(false); }}>Clear now</button></div>
              <p className="key-expiry">This key will be removed from the screen automatically after 30 seconds.</p>
              {backupError && <p className="form-error">{backupError}</p>}
            </>}
          </div>
        </section>
      </div>}
      {activationOpen && <div className="activation-backdrop"><div className="activation-modal"><span className="activation-icon">▶</span><small>REAL SOL EXECUTION</small><h2>Activate {migrationLiveMode ? "Migration Live" : "New Pairs Live"}?</h2><p>Lockstep will automatically sign real mainnet buys and exits from this dedicated wallet while the tab remains open.</p><div><span>STRATEGY <b>{migrationLiveMode ? "Post-migration rug entries" : "Fresh Pump.fun launches"}</b></span><span>REAL ORDER SIZE <b>{migrationLiveMode ? `${migrationLiveSettings.buyAmount} SOL exact` : `${newPairsSettings.buyAmount} base / ${newPairsSettings.adaptiveBuyAmount} SOL quote-up`}</b></span><span>DAILY LOSS LIMIT <b>{activeSettings.dailyLoss} SOL</b></span></div><label><input type="checkbox" id="risk-confirmation" /> <span>I understand this specific mode uses real SOL and can lose the wallet balance.</span></label><div className="activation-actions"><button className="secondary-button" onClick={() => setActivationOpen(false)}>Cancel</button><button className="primary-button" onClick={() => { const checkbox = document.getElementById("risk-confirmation") as HTMLInputElement | null; if (!checkbox?.checked) return; setEngineMode("active"); setActivationOpen(false); addExecutionActivity(`${migrationLiveMode ? "Migration Live" : "New Pairs Live"} active`, `Real-SOL execution armed for this browser session`, "good"); }}>Activate with real SOL</button></div></div></div>}
    </main>
  );
}

function Brand() {
  return <div className="brand"><img className="brand-mark" src="/lockstep-mark.svg" alt="" aria-hidden="true" /><div><b>LOCKSTEP</b><small>EXECUTION CONSOLE</small></div></div>;
}

function SecurityNote() {
  return <div className="security-note"><i>⌾</i><span><b>Your key never leaves this device</b><small>Lockstep stores encrypted ciphertext locally. We cannot view or recover your password.</small></span></div>;
}

function WalletPasswordFields({ password, confirmPassword, setPassword, setConfirmPassword }: { password: string; confirmPassword: string; setPassword: (value: string) => void; setConfirmPassword: (value: string) => void }) {
  return <div className="password-grid"><label className="field-label">PASSWORD<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="At least 10 characters" autoComplete="new-password" /></label><label className="field-label">CONFIRM<input type="password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} placeholder="Repeat password" autoComplete="new-password" /></label></div>;
}

function WalletPasswordForm({ title, description, password, confirmPassword, setPassword, setConfirmPassword, error, busy, submitLabel, onSubmit, onBack }: { title: string; description: string; password: string; confirmPassword: string; setPassword: (value: string) => void; setConfirmPassword: (value: string) => void; error: string; busy: boolean; submitLabel: string; onSubmit: () => void; onBack: () => void }) {
  return <><button className="back-button" onClick={onBack}>← Back</button><div className="step-kicker">CREATE WALLET</div><h2>{title}</h2><p className="muted">{description}</p><WalletPasswordFields password={password} confirmPassword={confirmPassword} setPassword={setPassword} setConfirmPassword={setConfirmPassword} />{error && <p className="form-error">{error}</p>}<button className="primary-button" disabled={busy} onClick={onSubmit}>{busy ? "Encrypting…" : submitLabel}</button><SecurityNote /></>;
}

function Metric({ label, value, detail, accent = false }: { label: string; value: string; detail: string; accent?: boolean }) {
  return <article className={`metric-card panel ${accent ? "accent" : ""}`}><small>{label}</small><b>{value}</b><p>{detail}</p></article>;
}

function Rule({ label, value, danger = false, good = false }: { label: string; value: string; danger?: boolean; good?: boolean }) {
  return <div><span>{label}</span><b className={danger ? "danger" : good ? "good" : ""}>{value}</b></div>;
}

function SettingsDrawer({ initialMode, migrationSettings, migrationLiveSettings, newPairsSettings, onClose, onSave }: { initialMode: StrategyMode; migrationSettings: typeof migrationDefaults; migrationLiveSettings: typeof migrationLiveDefaults; newPairsSettings: typeof defaults; onClose: () => void; onSave: (migration: typeof migrationDefaults, migrationLive: typeof migrationLiveDefaults, newPairs: typeof defaults) => void }) {
  const [mode, setMode] = useState<StrategyMode>(initialMode);
  const [migrationDraft, setMigrationDraft] = useState(migrationSettings);
  const [migrationLiveDraft, setMigrationLiveDraft] = useState(migrationLiveSettings);
  const [newPairsDraft, setNewPairsDraft] = useState(newPairsSettings);
  const migrationMode = mode !== "new-pairs-live";
  const paperMode = mode === "migration-paper";
  const migrationModeDraft = paperMode ? migrationDraft : migrationLiveDraft;
  const draft = migrationMode ? migrationModeDraft : newPairsDraft;
  const set = (key: keyof typeof defaults, value: number) => paperMode
    ? setMigrationDraft((current) => ({ ...current, [key]: value }))
    : mode === "migration-live"
      ? setMigrationLiveDraft((current) => ({ ...current, [key]: value }))
      : setNewPairsDraft((current) => ({ ...current, [key]: value }));
  const setMigrationValue = (key: keyof typeof migrationDefaults, value: number) => paperMode
    ? setMigrationDraft((current) => ({ ...current, [key]: value }))
    : setMigrationLiveDraft((current) => ({ ...current, [key]: value }));
  const field = (label: string, key: keyof typeof defaults, suffix: string | undefined, step: number) => <NumberField label={label} suffix={suffix} value={draft[key]} step={step} onChange={(value) => set(key, value)} />;
  const normalizedMigration = (value: typeof migrationDefaults) => ({ ...value, boostEntryMinMarketCapUsd: Math.min(value.boostEntryMinMarketCapUsd, value.boostEntryMarketCapUsd), boostEntryMarketCapUsd: Math.max(value.boostEntryMinMarketCapUsd, value.boostEntryMarketCapUsd) });

  return <div className="drawer-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <aside className="settings-drawer">
      <div className="drawer-heading"><div><small>CONFIGURATION</small><h2>Strategy settings</h2><p>Each strategy keeps its own independent limits.</p></div><button onClick={onClose}>×</button></div>
      <div className="settings-strategy-tabs" role="tablist" aria-label="Strategy settings">
        <button role="tab" aria-selected={mode === "migration-live"} className={mode === "migration-live" ? "selected live" : ""} onClick={() => setMode("migration-live")}><b>Migration Live</b><small>Real SOL</small></button>
        <button role="tab" aria-selected={mode === "new-pairs-live"} className={mode === "new-pairs-live" ? "selected live" : ""} onClick={() => setMode("new-pairs-live")}><b>New Pairs Live</b><small>Real SOL</small></button>
        <button role="tab" aria-selected={mode === "migration-paper"} className={mode === "migration-paper" ? "selected paper-choice" : "paper-choice"} onClick={() => setMode("migration-paper")}><b>Paper Lab</b><small>Fake SOL · isolated</small></button>
      </div>
      <div className="settings-mode-note"><i>{paperMode ? "PAPER" : "LIVE"}</i><span><b>{paperMode ? "Migration Paper Lab" : mode === "migration-live" ? "Migration Live" : "New Pairs Live"}</b><small>{paperMode ? "A separate fake-SOL laboratory that cannot sign transactions." : mode === "migration-live" ? "The migration strategy signs real mainnet entries and exits." : "Fresh Pump.fun launches with real wallet execution."}</small></span></div>
      <div className="settings-section"><h3>Entry</h3><div className="settings-grid">
        {field(migrationMode ? paperMode ? "Exact test order" : "Exact live order" : "Base order size", "buyAmount", paperMode ? "FAKE SOL" : "SOL", 0.001)}
        {migrationMode ? <>{paperMode && field("Paper starting balance", "paperStartingBalance", "FAKE SOL", 0.1)}<NumberField label="Entry minimum" suffix="USD MC" value={migrationModeDraft.boostEntryMinMarketCapUsd} step={100} onChange={(value) => setMigrationValue("boostEntryMinMarketCapUsd", value)} /><NumberField label="Entry maximum" suffix="USD MC" value={migrationModeDraft.boostEntryMarketCapUsd} step={100} onChange={(value) => setMigrationValue("boostEntryMarketCapUsd", value)} />{field("Buy slippage", "slippage", "%", 0.1)}<NumberField label="Sell slippage" suffix="%" value={migrationModeDraft.exitImpact} step={0.1} onChange={(value) => setMigrationValue("exitImpact", value)} /></> : <>{field("Quote-up order size", "adaptiveBuyAmount", "SOL", 0.01)}{field("Maximum live impact", "maxQuoteImpact", "%", 0.1)}{field("Transaction slippage", "slippage", "%", 0.1)}</>}
        {field("Maximum positions", "maxPositions", undefined, 1)}
      </div></div>
      {migrationMode && <div className="settings-section"><h3>Timed exit</h3><div className="settings-grid"><NumberField label="Sell each interval" suffix="% REMAINING" value={migrationModeDraft.boostSellSlicePercent} step={1} onChange={(value) => setMigrationValue("boostSellSlicePercent", value)} /><NumberField label="Sell interval" suffix="SEC" value={migrationModeDraft.boostSellIntervalSeconds} step={1} onChange={(value) => setMigrationValue("boostSellIntervalSeconds", value)} />{field("Instant full exit", "takeProfit", "% PROFIT", 10)}</div></div>}
      <div className="settings-section"><h3>Protection</h3><div className="settings-grid">{field("Daily loss limit", "dailyLoss", paperMode ? "FAKE SOL" : "SOL", 0.001)}{mode === "new-pairs-live" && <>{field("Stop loss", "stopLoss", "%", 0.1)}{field("Take profit", "takeProfit", "%", 1)}{field("Maximum hold", "maxHold", "SEC", 1)}</>}</div></div>
      <div className={`drawer-warning ${paperMode ? "paper" : ""}`}>{paperMode ? "This isolated lab uses live market data and fake SOL only. It cannot sign or submit a wallet transaction." : mode === "migration-live" ? "Migration Live submits the exact configured SOL order to mainnet, then sells the configured percentage of remaining tokens each interval. It has no stop loss and attempts a full exit at the profit target or five-minute deadline. Transactions can fail, and the entire amount can be lost." : "Lockstep quotes the larger order first, falls back to the base amount when needed, and skips the trade if the fresh quote is missing, older than two seconds, or at/above the impact limit."}</div>
      <div className="drawer-actions"><button className="secondary-button" onClick={onClose}>Cancel</button><button className="primary-button" onClick={() => onSave(normalizedMigration(migrationDraft), { ...normalizedMigration(migrationLiveDraft), paperStartingBalance: 0 }, { ...newPairsDraft, adaptiveBuyAmount: Math.max(newPairsDraft.buyAmount, newPairsDraft.adaptiveBuyAmount) })}>Save all strategies</button></div>
    </aside>
  </div>;
}

function NumberField({ label, suffix, value, step, onChange }: { label: string; suffix?: string; value: number; step: number; onChange: (value: number) => void }) {
  return <label className="number-field"><span>{label}{suffix && <em>{suffix}</em>}</span><input type="number" min={step} step={step} value={value} onChange={(event) => onChange(Number(event.target.value))} /></label>;
}
