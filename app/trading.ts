"use client";

import { AccountLayout } from "@solana/spl-token";
import type { OnlinePumpAmmSdk, SwapSolanaState } from "@pump-fun/pump-swap-sdk";
import { ComputeBudgetProgram, Connection, Keypair, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import BN from "bn.js";

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
  observedAt?: number;
  observationSource?: "trade-stream" | "processed-signal" | "poll";
  observationPool?: string;
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

type PumpSwapEntryGuard = {
  reportedMarketCapUsd?: number;
  minimumMarketCapUsd: number;
  maximumEntryMarketCapUsd: number;
  maximumFillMarketCapUsd: number;
  solUsdPrice: number;
  latestSubmitAt?: number;
  minimumRemainingSeconds?: number;
};

export type LiveExecutionDiagnostics = {
  attempt: number;
  builder: "local-pumpswap" | "remote" | "remote-fallback" | "unknown";
  builderFallbackReason?: string;
  buildMs: number;
  signMs: number;
  fundingCheckMs: number;
  submitMs: number;
  confirmMs: number;
  totalMs: number;
  signalToSubmitMs?: number;
  routesAttempted: number;
  acceptedBy?: string;
};

export type TokenTradeStreamStatus = "connecting" | "live" | "error";
export type TokenTradeWatcher = (
  mint: string,
  onTrade: (mark: LaunchCandidate) => void,
  onStatus?: (status: TokenTradeStreamStatus) => void,
  onProcessedSignal?: () => void,
) => () => void;

const LAMPORTS_PER_SOL = 1_000_000_000;
const TOTAL_BONDING_CURVE_FEE_BPS = 125n;
const PROTOCOL_FEE_BPS = 95n;
const CREATOR_FEE_BPS = 30n;

// --- Dynamic priority fee -------------------------------------------------
// Fresh migration entries are a race against other bots for block inclusion.
// A flat priority fee loses that race whenever network demand rises above
// the fixed bid. These constants bound a fee that adapts to real recent
// network competition instead.
const DEFAULT_PRIORITY_FEE_SOL = 0.01;
const MIN_LIVE_PRIORITY_FEE_SOL = 0.01;
const MAX_LIVE_PRIORITY_FEE_SOL = 0.06; // user-approved hard cap for highly competitive migration blocks
const ESTIMATED_COMPUTE_UNITS = 300_000;
const PRIORITY_FEE_CACHE_MS = 15_000;
const PUMP_SWAP_PREPARATION_TTL_MS = 5 * 60_000;
const MAX_PREPARED_PUMP_SWAP_POOLS = 64;
const TRADE_STREAM_FAILURE_GRACE_MS = 5_000;

let cachedPriorityFeeSol = DEFAULT_PRIORITY_FEE_SOL;
let priorityFeeExpiresAt = 0;
let priorityFeeRefresh: Promise<number> | null = null;
let pumpSwapConnection: Connection | null = null;
let pumpSwapOnlineSdk: OnlinePumpAmmSdk | null = null;
let pumpSwapModulePromise: Promise<typeof import("@pump-fun/pump-swap-sdk")> | null = null;
const preparedPumpSwapStates = new Map<string, Promise<{ state: SwapSolanaState; preparedAt: number }>>();

async function fetchCompetitivePriorityFeeSol(): Promise<number> {
  try {
    const samples = await rpc("getRecentPrioritizationFees", [[]]) as Array<{ prioritizationFee: number }>;
    const fees = samples
      .map((sample) => Number(sample.prioritizationFee))
      .filter((fee) => Number.isFinite(fee) && fee >= 0)
      .sort((a, b) => a - b);
    if (fees.length === 0) return DEFAULT_PRIORITY_FEE_SOL;
    // Bid above the 75th percentile of recent network fees, not the median —
    // migration entries are a race, being "average" competitive still loses.
    const p75 = fees[Math.min(fees.length - 1, Math.floor(fees.length * 0.75))];
    const bidMicroLamportsPerCu = p75 * 2 + 1;
    const feeSol = (bidMicroLamportsPerCu * ESTIMATED_COMPUTE_UNITS) / 1_000_000 / LAMPORTS_PER_SOL;
    return Math.min(MAX_LIVE_PRIORITY_FEE_SOL, Math.max(MIN_LIVE_PRIORITY_FEE_SOL, feeSol));
  } catch {
    return DEFAULT_PRIORITY_FEE_SOL; // never block a trade because the fee-sampling RPC hiccuped
  }
}

function refreshCompetitivePriorityFeeSol(): Promise<number> {
  if (priorityFeeRefresh) return priorityFeeRefresh;
  priorityFeeRefresh = fetchCompetitivePriorityFeeSol()
    .then((fee) => {
      cachedPriorityFeeSol = fee;
      priorityFeeExpiresAt = Date.now() + PRIORITY_FEE_CACHE_MS;
      return fee;
    })
    .finally(() => {
      priorityFeeRefresh = null;
    });
  return priorityFeeRefresh;
}

function getCachedCompetitivePriorityFeeSol(): number {
  if (Date.now() >= priorityFeeExpiresAt) void refreshCompetitivePriorityFeeSol();
  return cachedPriorityFeeSol;
}

/** Warm fee data while the scanner is waiting instead of blocking the buy path. */
export function warmLiveTradePreparation() {
  void refreshCompetitivePriorityFeeSol();
}

async function getPumpSwapClients() {
  pumpSwapModulePromise ??= import("@pump-fun/pump-swap-sdk");
  const pumpSwapModule = await pumpSwapModulePromise;
  if (!pumpSwapConnection || !pumpSwapOnlineSdk) {
    const endpoint = new URL("/api/rpc", window.location.origin).toString();
    pumpSwapConnection = new Connection(endpoint, { commitment: "processed", disableRetryOnRateLimit: true });
    pumpSwapOnlineSdk = new pumpSwapModule.OnlinePumpAmmSdk(pumpSwapConnection);
  }
  return { connection: pumpSwapConnection, onlineSdk: pumpSwapOnlineSdk, pumpSwapModule };
}

function pumpSwapPreparationKey(mint: string, user: PublicKey) {
  return `${mint}:${user.toBase58()}`;
}

function preparePumpSwapState(mint: string, user: PublicKey) {
  const key = pumpSwapPreparationKey(mint, user);
  const existing = preparedPumpSwapStates.get(key);
  if (existing) return existing;
  if (preparedPumpSwapStates.size >= MAX_PREPARED_PUMP_SWAP_POOLS) {
    const oldest = preparedPumpSwapStates.keys().next().value;
    if (oldest) preparedPumpSwapStates.delete(oldest);
  }
  const preparation = getPumpSwapClients()
    .then(({ onlineSdk, pumpSwapModule }) => onlineSdk.swapSolanaState(pumpSwapModule.canonicalPumpPoolPda(new PublicKey(mint)), user))
    .then((state) => ({ state, preparedAt: Date.now() }))
    .catch((error) => {
      preparedPumpSwapStates.delete(key);
      throw error;
    });
  preparedPumpSwapStates.set(key, preparation);
  return preparation;
}

/** Begin fetching immutable PumpSwap accounts while the token is only being watched. */
export function warmPumpSwapBuy(mint: string, user: PublicKey) {
  void preparePumpSwapState(mint, user).catch(() => {
    // A just-created pool may not be indexed yet. The execution path retries.
  });
}

async function buildLocalPumpSwapBuyTransaction({ keypair, mint, amountSol, slippagePercent, priorityFeeSol, entryGuard }: {
  keypair: Keypair;
  mint: string;
  amountSol: number;
  slippagePercent: number;
  priorityFeeSol: number;
  entryGuard?: PumpSwapEntryGuard;
}) {
  const key = pumpSwapPreparationKey(mint, keypair.publicKey);
  let prepared = await preparePumpSwapState(mint, keypair.publicKey);
  if (Date.now() - prepared.preparedAt > PUMP_SWAP_PREPARATION_TTL_MS) {
    preparedPumpSwapStates.delete(key);
    prepared = await preparePumpSwapState(mint, keypair.publicKey);
  }
  const { connection, pumpSwapModule } = await getPumpSwapClients();
  const { state } = prepared;
  const accountKeys = [
    state.poolKey,
    state.pool.poolBaseTokenAccount,
    state.pool.poolQuoteTokenAccount,
    state.userBaseTokenAccount,
    state.userQuoteTokenAccount,
  ];
  const [accountInfos, blockhashResult] = await Promise.all([
    connection.getMultipleAccountsInfo(accountKeys, "processed"),
    rpc("getLatestBlockhash", [{ commitment: "processed" }]) as Promise<{ value?: { blockhash?: string } }>,
  ]);
  const [poolAccountInfo, poolBaseAccountInfo, poolQuoteAccountInfo, userBaseAccountInfo, userQuoteAccountInfo] = accountInfos;
  if (!poolAccountInfo || !poolBaseAccountInfo || !poolQuoteAccountInfo) throw new Error("Fresh PumpSwap pool accounts were unavailable");
  const blockhash = blockhashResult.value?.blockhash;
  if (!blockhash) throw new Error("A fresh Solana blockhash was unavailable");
  const pool = pumpSwapModule.PUMP_AMM_SDK.decodePool(poolAccountInfo);
  const poolBaseAmount = new BN(AccountLayout.decode(poolBaseAccountInfo.data).amount.toString());
  const poolQuoteAmount = new BN(AccountLayout.decode(poolQuoteAccountInfo.data).amount.toString());
  const freshState: SwapSolanaState = {
    ...state,
    pool,
    poolAccountInfo,
    poolBaseAmount,
    poolQuoteAmount,
    userBaseAccountInfo,
    userQuoteAccountInfo,
  };
  const quoteLamports = Math.round(amountSol * LAMPORTS_PER_SOL);
  if (!Number.isSafeInteger(quoteLamports) || quoteLamports <= 0) throw new Error("The local PumpSwap order amount was invalid");
  const spendableQuoteIn = new BN(quoteLamports);
  const baseUnitScale = 10 ** Number(state.baseMintAccount.decimals);
  const totalSupplyTokens = Number(state.baseMintAccount.supply.toString()) / baseUnitScale;
  let verifiedMarketCapUsd = Number.NaN;
  if (entryGuard) {
    // PumpPortal is deliberately only the low-latency wake-up signal. These
    // accounts are the same fresh processed-state read used to quote and build
    // the transaction, so verifying the real PumpSwap spot adds no RPC round
    // trip to the critical path.
    const effectiveQuoteReserveLamports = poolQuoteAmount.add(pool.virtualQuoteReserves);
    const poolBaseTokens = Number(poolBaseAmount.toString()) / baseUnitScale;
    const effectiveQuoteReserveSol = Number(effectiveQuoteReserveLamports.toString()) / LAMPORTS_PER_SOL;
    const verifiedSpotPriceSol = effectiveQuoteReserveSol / poolBaseTokens;
    verifiedMarketCapUsd = verifiedSpotPriceSol * totalSupplyTokens * entryGuard.solUsdPrice;
    if (!Number.isFinite(verifiedMarketCapUsd)
      || verifiedMarketCapUsd < entryGuard.minimumMarketCapUsd
      || verifiedMarketCapUsd > entryGuard.maximumEntryMarketCapUsd) {
      const reported = Number.isFinite(entryGuard.reportedMarketCapUsd)
        ? ` (PumpPortal reported $${Number(entryGuard.reportedMarketCapUsd).toFixed(0)})`
        : "";
      throw new LiveTradeEntryGuardError(
        `Verified on-chain MC $${Number.isFinite(verifiedMarketCapUsd) ? verifiedMarketCapUsd.toFixed(0) : "unavailable"}${reported} was outside the $${entryGuard.minimumMarketCapUsd.toFixed(0)}–$${entryGuard.maximumEntryMarketCapUsd.toFixed(0)} entry range`,
      );
    }
  }
  const quote = pumpSwapModule.buyQuoteInput({
    quote: spendableQuoteIn,
    slippage: 0,
    baseReserve: poolBaseAmount,
    quoteReserve: poolQuoteAmount,
    virtualQuoteReserves: pool.virtualQuoteReserves,
    globalConfig: state.globalConfig,
    baseMintAccount: state.baseMintAccount,
    baseMint: state.baseMint,
    coinCreator: pool.coinCreator,
    creator: pool.creator,
    feeConfig: state.feeConfig,
  });
  let minimumMarketCapBaseAmountOut = new BN(0);
  if (entryGuard) {
    const estimatedTokensOut = Number(quote.base.toString()) / baseUnitScale;
    const projectedFillMarketCapUsd = amountSol / estimatedTokensOut * totalSupplyTokens * entryGuard.solUsdPrice;
    const projectedImpactPercent = (projectedFillMarketCapUsd / verifiedMarketCapUsd - 1) * 100;
    if (!Number.isFinite(projectedFillMarketCapUsd)
      || !Number.isFinite(projectedImpactPercent)
      || projectedFillMarketCapUsd > entryGuard.maximumFillMarketCapUsd) {
      throw new LiveTradeEntryGuardError(
        `Projected average fill $${projectedFillMarketCapUsd.toFixed(0)} MC · ${Math.max(0, projectedImpactPercent).toFixed(1)}% above verified spot exceeds the $${entryGuard.maximumFillMarketCapUsd.toFixed(0)} MC fill maximum`,
      );
    }
    const minimumTokensOut = amountSol * totalSupplyTokens * entryGuard.solUsdPrice / entryGuard.maximumFillMarketCapUsd;
    const minimumRawBaseAmountOut = Math.ceil(minimumTokensOut * baseUnitScale);
    if (!Number.isSafeInteger(minimumRawBaseAmountOut) || minimumRawBaseAmountOut <= 0) {
      throw new LiveTradeEntryGuardError("Entry protection could not calculate the strategy's maximum confirmed fill");
    }
    minimumMarketCapBaseAmountOut = new BN(minimumRawBaseAmountOut.toString());
  }
  const slippageScale = 100_000_000;
  const slippageUnits = Math.min(slippageScale, Math.max(0, Math.floor(slippagePercent * 1_000_000)));
  const slippageMinBaseAmountOut = quote.base.mul(new BN(slippageScale - slippageUnits)).div(new BN(slippageScale));
  const minBaseAmountOut = minimumMarketCapBaseAmountOut.gt(slippageMinBaseAmountOut)
    ? minimumMarketCapBaseAmountOut
    : slippageMinBaseAmountOut;
  const buyInstructions = await pumpSwapModule.PUMP_AMM_SDK.buyInstructions(freshState, quote.base, spendableQuoteIn);
  const buyInstructionIndex = buyInstructions.findIndex((instruction) =>
    instruction.programId.toBase58() === PUMP_AMM_PROGRAM && instruction.data.length > 8);
  if (buyInstructionIndex < 0) throw new Error("The local builder could not locate the PumpSwap buy instruction");
  const originalBuyInstruction = buyInstructions[buyInstructionIndex];
  buyInstructions[buyInstructionIndex] = new TransactionInstruction({
    programId: originalBuyInstruction.programId,
    keys: originalBuyInstruction.keys,
    data: pumpSwapModule.OFFLINE_PUMP_AMM_PROGRAM.coder.instruction.encode("buyExactQuoteIn", {
      spendableQuoteIn,
      minBaseAmountOut,
      trackVolume: { 0: true },
    }),
  });
  const microLamportsPerUnit = Math.max(1, Math.ceil(priorityFeeSol * LAMPORTS_PER_SOL * 1_000_000 / ESTIMATED_COMPUTE_UNITS));
  const message = new TransactionMessage({
    payerKey: keypair.publicKey,
    recentBlockhash: blockhash,
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: ESTIMATED_COMPUTE_UNITS }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: microLamportsPerUnit }),
      ...buyInstructions,
    ],
  }).compileToV0Message();
  const transaction = new VersionedTransaction(message);
  if (!transaction.message.staticAccountKeys.some((address) => address.toBase58() === PUMP_AMM_PROGRAM)) {
    throw new Error("The local builder did not create a PumpSwap transaction");
  }
  return transaction;
}
// ---------------------------------------------------------------------------

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

type RpcEnvelope = {
  result?: unknown;
  error?: { message?: string } | string;
  lockstep?: { routesAttempted?: number; acceptedBy?: string };
};

class RpcRequestError extends Error {
  lockstep?: RpcEnvelope["lockstep"];

  constructor(message: string, lockstep?: RpcEnvelope["lockstep"]) {
    super(message);
    this.name = "RpcRequestError";
    this.lockstep = lockstep;
  }
}

async function rpcEnvelope(method: string, params: unknown[]): Promise<RpcEnvelope> {
  const response = await fetch("/api/rpc", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ method, params }),
  });
  const payload = await response.json();
  if (!response.ok || payload.error) {
    const message = typeof payload.error === "object" ? payload.error?.message : payload.error;
    throw new RpcRequestError(message ?? `${method} failed`, payload.lockstep);
  }
  return payload;
}

async function rpc(method: string, params: unknown[]) {
  return (await rpcEnvelope(method, params)).result;
}

// PumpPortal's trade-local builder can lag a few seconds behind fresh on-chain
// state (a brand-new bonding-curve completion or a brand-new PumpSwap pool).
const PUMP_BONDING_CURVE_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78rvF6kCUKqJ4M5uBEwF6P";
const PUMP_AMM_PROGRAM = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";

// A transaction built during that gap targets accounts that no longer (or don't
// yet) match reality. Match the bonding-curve program or its explicit messages;
// PumpSwap uses overlapping numeric Anchor errors with different meanings.
function isStalePoolRoutingError(rawMessage: string): boolean {
  return /BondingCurveComplete|stale bonding.?curve|bonding curve (?:is )?complete|liquidity migrated/i.test(rawMessage)
    || (rawMessage.includes(PUMP_BONDING_CURVE_PROGRAM) && /custom program error: 0x1775\b|Custom"?:\s*6005\b/i.test(rawMessage));
}

function isPumpSwapSlippageError(rawMessage: string): boolean {
  return /ExceededSlippage/i.test(rawMessage)
    || (rawMessage.includes(PUMP_AMM_PROGRAM) && /custom program error: 0x1774\b|Custom"?:\s*6004\b/i.test(rawMessage));
}

function isPostMigrationTradePool(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const pool = value.trim().toLowerCase().replace(/[\s_]+/g, "-");
  return pool === "pump-amm" || pool === "pump-swap" || pool === "pumpswap";
}

function stringifyTradeError(value: unknown): string {
  if (typeof value === "string") return value;
  try { return JSON.stringify(value); } catch { return String(value); }
}

export class LiveTradeError extends Error {
  signature?: string;
  rawError?: unknown;
  logs?: string[];
  confirmedOnChainFailure: boolean;
  attempts = 1;
  executionDiagnostics?: LiveExecutionDiagnostics;

  constructor(message: string, options: { signature?: string; rawError?: unknown; confirmedOnChainFailure?: boolean } = {}) {
    super(message);
    this.name = "LiveTradeError";
    this.signature = options.signature;
    this.rawError = options.rawError;
    this.confirmedOnChainFailure = options.confirmedOnChainFailure ?? false;
  }
}

export class LiveTradeFundingError extends Error {
  balanceSol: number;
  requiredSol: number;
  executionDiagnostics?: LiveExecutionDiagnostics;

  constructor(balanceSol: number, requiredSol: number, message = "The wallet cannot fund the complete transaction") {
    super(message);
    this.name = "LiveTradeFundingError";
    this.balanceSol = balanceSol;
    this.requiredSol = requiredSol;
  }
}

function tradeErrorText(error: unknown): string {
  if (error instanceof LiveTradeError) {
    return [error.message, stringifyTradeError(error.rawError), ...(error.logs ?? [])].filter(Boolean).join(" · ");
  }
  return error instanceof Error ? error.message : stringifyTradeError(error);
}

/** Only confirmed failures are safe to rebuild automatically; a timeout may still land. */
export function isRetryableLiveTradeFailure(error: unknown): boolean {
  if (error instanceof LiveTradeFundingError) return false;
  if (!(error instanceof LiveTradeError) || !error.confirmedOnChainFailure) return false;
  const detail = tradeErrorText(error);
  if (/Program 11111111111111111111111111111111 failed: custom program error: 0x1\b/i.test(detail)) return false;
  return isPumpSwapSlippageError(detail) || /slippage|price.*(moved|impact)|minimum.*out|too little output/i.test(detail);
}

export function describeLiveTradeFailure(error: unknown): string {
  const executionDetail = formatLiveExecutionDiagnostics(error);
  const executionDiagnostic = executionDetail ? ` · ${executionDetail}` : "";
  if (error instanceof LiveTradeFundingError) {
    return `not enough SOL for the complete transaction · balance ${error.balanceSol.toFixed(4)} SOL · deposit to at least ${error.requiredSol.toFixed(4)} SOL${executionDiagnostic}`;
  }
  const rawMessage = tradeErrorText(error);
  const lastProgramLog = error instanceof LiveTradeError && error.logs?.length
    ? error.logs[error.logs.length - 1]?.replace(/^Program log:\s*/i, "").slice(0, 120)
    : "";
  const diagnostic = error instanceof LiveTradeError
    ? `${error.signature ? ` · tx ${error.signature.slice(0, 12)}…` : ""}${error.attempts > 1 ? ` · ${error.attempts} fresh attempts` : ""}${lastProgramLog ? ` · log: ${lastProgramLog}` : ""}${executionDiagnostic}`
    : executionDiagnostic;
  if (/Program 11111111111111111111111111111111 failed: custom program error: 0x1\b/i.test(rawMessage)) {
    return `the Solana System Program rejected a debit that would make an account balance negative; the wallet did not have enough spendable SOL for the complete transaction${diagnostic}`;
  }
  if (/custom.*:\s*1\b/i.test(rawMessage) || /custom program error: 0x1\b/i.test(rawMessage)) {
    return `the trading program rejected the transaction on-chain (Custom:1)${diagnostic}`;
  }
  if (isPumpSwapSlippageError(rawMessage)) {
    return `PumpSwap rejected the fresh quote because executable output moved beyond its slippage limit${diagnostic}`;
  }
  if (isStalePoolRoutingError(rawMessage)) {
    return `the pool routing was stale, this coin had already migrated off the bonding curve${diagnostic}`;
  }
  if (/confirmation timed out/i.test(rawMessage)) {
    return `the transaction never confirmed in time, likely network congestion or it was dropped${diagnostic}`;
  }
  if (/could not build transaction/i.test(rawMessage)) {
    return `the trade builder could not prepare an order for this coin${diagnostic}`;
  }
  if (/insufficient/i.test(rawMessage)) {
    return `not enough SOL in the wallet for this order${diagnostic}`;
  }
  if (/blockhash/i.test(rawMessage)) {
    return `the transaction expired before it could land, the network was too slow${diagnostic}`;
  }
  return `${rawMessage}${diagnostic}`;
}

export class LiveTradeEntryGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LiveTradeEntryGuardError";
  }
}

async function buildRemoteTradeTransaction({ keypair, action, mint, amount, slippagePercent, pool, priorityFeeSol }: { keypair: Keypair; action: "buy" | "sell"; mint: string; amount: number | string; slippagePercent: number; pool: "auto" | "pump" | "pump-amm"; priorityFeeSol: number }) {
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
      priorityFee: priorityFeeSol,
      pool,
    }),
  });
  const payload = await response.json();
  if (!response.ok || !payload.transaction) throw new Error(payload.error ?? "Could not build transaction");
  return VersionedTransaction.deserialize(base64ToBytes(payload.transaction));
}

type ErrorWithExecutionDiagnostics = Error & { executionDiagnostics?: LiveExecutionDiagnostics };

function attachExecutionDiagnostics(error: unknown, diagnostics: LiveExecutionDiagnostics): ErrorWithExecutionDiagnostics {
  const normalized = error instanceof Error ? error as ErrorWithExecutionDiagnostics : new LiveTradeError(stringifyTradeError(error), { rawError: error });
  normalized.executionDiagnostics = { ...diagnostics };
  return normalized;
}

function diagnosticsFrom(value: unknown) {
  return value instanceof Error ? (value as ErrorWithExecutionDiagnostics).executionDiagnostics : undefined;
}

function formatDuration(milliseconds: number) {
  if (milliseconds >= 1_000) return `${(milliseconds / 1_000).toFixed(2)}s`;
  return `${Math.max(0, Math.round(milliseconds))}ms`;
}

export function formatLiveExecutionDiagnostics(value: unknown) {
  const detail = value && typeof value === "object" && "builder" in value
    ? value as LiveExecutionDiagnostics
    : diagnosticsFrom(value);
  if (!detail) return "";
  const route = detail.routesAttempted > 1
    ? `${detail.routesAttempted} RPC routes${detail.acceptedBy ? `, ${detail.acceptedBy} first` : ""}`
    : `${Math.max(1, detail.routesAttempted)} RPC route${detail.acceptedBy ? `, ${detail.acceptedBy}` : ""}`;
  return [
    `execution ${detail.builder}`,
    detail.builderFallbackReason ? `local builder: ${detail.builderFallbackReason}` : "",
    `attempt ${detail.attempt}`,
    detail.signalToSubmitMs === undefined ? "" : `signal→send ${formatDuration(detail.signalToSubmitMs)}`,
    `build ${formatDuration(detail.buildMs)}`,
    `sign ${formatDuration(detail.signMs)}`,
    `funding ${formatDuration(detail.fundingCheckMs)}`,
    `submit ${formatDuration(detail.submitMs)} via ${route}`,
    `confirm ${formatDuration(detail.confirmMs)}`,
    `total ${formatDuration(detail.totalMs)}`,
  ].filter(Boolean).join(" · ");
}

async function attemptTrade({ keypair, action, mint, amount, slippagePercent, pool, priorityFeeSol, knownBalanceSol, attempt, signalObservedAt, entryGuard }: { keypair: Keypair; action: "buy" | "sell"; mint: string; amount: number | string; slippagePercent: number; pool: "auto" | "pump" | "pump-amm"; priorityFeeSol: number; knownBalanceSol?: number; attempt: number; signalObservedAt?: number; entryGuard?: PumpSwapEntryGuard }) {
  const attemptStartedAt = performance.now();
  const diagnostics: LiveExecutionDiagnostics = {
    attempt,
    builder: "unknown",
    buildMs: 0,
    signMs: 0,
    fundingCheckMs: 0,
    submitMs: 0,
    confirmMs: 0,
    totalMs: 0,
    routesAttempted: 1,
  };
  let activePhase: "build" | "sign" | "funding" | "submit" | "confirm" | null = null;
  let activePhaseStartedAt = attemptStartedAt;
  const beginPhase = (phase: typeof activePhase) => {
    activePhase = phase;
    activePhaseStartedAt = performance.now();
  };
  const finishPhase = () => {
    const elapsed = performance.now() - activePhaseStartedAt;
    if (activePhase === "build") diagnostics.buildMs = elapsed;
    if (activePhase === "sign") diagnostics.signMs = elapsed;
    if (activePhase === "funding") diagnostics.fundingCheckMs = elapsed;
    if (activePhase === "submit") diagnostics.submitMs = elapsed;
    if (activePhase === "confirm") diagnostics.confirmMs = elapsed;
    activePhase = null;
  };
  try {
    const balancePromise = action === "buy"
      ? Number.isFinite(knownBalanceSol)
        ? Promise.resolve(Number(knownBalanceSol))
        : rpc("getBalance", [keypair.publicKey.toBase58(), { commitment: "confirmed" }]).then((result) => Number((result as { value?: number }).value ?? 0) / LAMPORTS_PER_SOL)
      : null;
    beginPhase("build");
    let transaction: VersionedTransaction;
    if (action === "buy" && pool === "pump-amm" && typeof amount === "number") {
      try {
        diagnostics.builder = "local-pumpswap";
        transaction = await buildLocalPumpSwapBuyTransaction({ keypair, mint, amountSol: amount, slippagePercent, priorityFeeSol, entryGuard });
      } catch (error) {
        if (error instanceof LiveTradeEntryGuardError) throw error;
        if (entryGuard) {
          const reason = error instanceof Error ? error.message : "fresh quote unavailable";
          throw new LiveTradeEntryGuardError(`Entry protection could not verify a fresh PumpSwap fill: ${reason}`);
        }
        // Preserve availability if a newly migrated pool is not indexed by the
        // read RPC yet. The existing PumpPortal builder remains a safe fallback.
        diagnostics.builder = "remote-fallback";
        diagnostics.builderFallbackReason = (error instanceof Error ? error.message : stringifyTradeError(error)).slice(0, 140);
        transaction = await buildRemoteTradeTransaction({ keypair, action, mint, amount, slippagePercent, pool, priorityFeeSol });
      }
    } else {
      diagnostics.builder = "remote";
      transaction = await buildRemoteTradeTransaction({ keypair, action, mint, amount, slippagePercent, pool, priorityFeeSol });
    }
    finishPhase();
    if (pool === "pump-amm" && transaction.message.staticAccountKeys
      .some((key) => key.toBase58() === PUMP_BONDING_CURVE_PROGRAM)) {
      throw new Error("The trade builder returned a stale bonding-curve transaction after migration");
    }
    beginPhase("sign");
    transaction.sign([keypair]);
    finishPhase();
    beginPhase("funding");
    if (action === "buy") {
      const balanceSol = await balancePromise!;
      // Covers the exact order, the priority fee selected for this transaction,
      // base signature fee, token-account rent and a small landing reserve.
      const requiredSol = Number(amount) + priorityFeeSol + 0.0021 + 0.000005 + 0.001;
      if (!Number.isFinite(balanceSol) || balanceSol < requiredSol) {
        throw new LiveTradeFundingError(balanceSol, requiredSol);
      }
      // A low-margin PumpSwap wallet gets one read-only simulation. It catches
      // transaction-specific account creation/rent that a generic reserve cannot
      // know before PumpPortal builds the transaction, without charging a fee.
      if (pool === "pump-amm" && balanceSol < Number(amount) + 0.015) {
        const simulation = await rpc("simulateTransaction", [bytesToBase64(transaction.serialize()), {
          encoding: "base64",
          commitment: "processed",
          sigVerify: true,
          accounts: { encoding: "base64", addresses: [keypair.publicKey.toBase58()] },
        }]) as { value?: { err?: unknown; logs?: string[] | null } };
        const simulationText = [stringifyTradeError(simulation.value?.err), ...(simulation.value?.logs ?? [])].join(" · ");
        if (/Program 11111111111111111111111111111111 failed: custom program error: 0x1\b/i.test(simulationText)) {
          throw new LiveTradeFundingError(balanceSol, Number(amount) + 0.015, "The built transaction requires more spendable lamports than this wallet has");
        }
      }
    }
    finishPhase();
    if (action === "buy" && entryGuard?.latestSubmitAt && Date.now() >= entryGuard.latestSubmitAt) {
      throw new LiveTradeEntryGuardError(`Fewer than ${Math.max(0, Number(entryGuard.minimumRemainingSeconds ?? 0))} seconds remained in the BOOST before transaction submission`);
    }
    const serializedTransaction = bytesToBase64(transaction.serialize());
    beginPhase("submit");
    if (Number.isFinite(signalObservedAt)) diagnostics.signalToSubmitMs = Math.max(0, Date.now() - Number(signalObservedAt));
    // The server broadcasts these exact signed bytes to every configured RPC.
    // Identical bytes have one signature, so multiple routes improve landing
    // without creating multiple orders.
    const submission = await rpcEnvelope("sendTransaction", [serializedTransaction, { encoding: "base64", skipPreflight: true, maxRetries: 3 }]);
    finishPhase();
    diagnostics.routesAttempted = Math.max(1, Number(submission.lockstep?.routesAttempted ?? 1));
    diagnostics.acceptedBy = submission.lockstep?.acceptedBy;
    const signature = submission.result;
    if (typeof signature !== "string" || !signature) throw new Error("Solana RPC did not return a transaction signature");
    beginPhase("confirm");
    await waitForConfirmation(signature);
    finishPhase();
    diagnostics.totalMs = performance.now() - attemptStartedAt;
    return { signature, diagnostics };
  } catch (caught) {
    if (activePhase) finishPhase();
    if (caught instanceof RpcRequestError) {
      diagnostics.routesAttempted = Math.max(1, Number(caught.lockstep?.routesAttempted ?? diagnostics.routesAttempted));
      diagnostics.acceptedBy = caught.lockstep?.acceptedBy;
    }
    diagnostics.totalMs = performance.now() - attemptStartedAt;
    throw attachExecutionDiagnostics(caught, diagnostics);
  }
}

async function enrichLiveTradeError(error: LiveTradeError) {
  if (!error.signature) return error;
  try {
    const transaction = await rpc("getTransaction", [error.signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }]) as { meta?: { logMessages?: string[] } } | null;
    error.logs = transaction?.meta?.logMessages?.slice(-8);
  } catch {
    // Diagnostics are best-effort and must never hide the original failure.
  }
  return error;
}

export async function buildSignAndSendTrade({ keypair, action, mint, amount, slippagePercent, priorityFeeSol, pool, knownBalanceSol, signalObservedAt, entryGuard, freshTransactionRetries = 0, shouldRetryFreshTransaction, onFreshTransactionRetry, onExecutionDiagnostics }: {
  keypair: Keypair;
  action: "buy" | "sell";
  mint: string;
  amount: number | string;
  slippagePercent: number;
  priorityFeeSol?: number;
  pool?: "auto" | "pump" | "pump-amm";
  knownBalanceSol?: number;
  signalObservedAt?: number;
  entryGuard?: PumpSwapEntryGuard;
  freshTransactionRetries?: number;
  shouldRetryFreshTransaction?: () => Promise<boolean>;
  onFreshTransactionRetry?: (attempt: number, diagnostics?: LiveExecutionDiagnostics) => void;
  onExecutionDiagnostics?: (diagnostics: LiveExecutionDiagnostics) => void;
}) {
  const requestedPool = pool ?? "auto";
  let activePool = requestedPool;
  let routeFallbackUsed = false;
  let freshRetriesUsed = 0;
  let attempts = 0;
  while (true) {
    attempts += 1;
    try {
      // The cache is refreshed in the background; fee lookup is no longer on
      // the latency-critical path between detecting the rug and submitting.
      const configuredPriorityFeeSol = Number(priorityFeeSol);
      const activePriorityFeeSol = Number.isFinite(configuredPriorityFeeSol) && configuredPriorityFeeSol > 0
        ? Math.min(MAX_LIVE_PRIORITY_FEE_SOL, configuredPriorityFeeSol)
        : getCachedCompetitivePriorityFeeSol();
      const result = await attemptTrade({ keypair, action, mint, amount, slippagePercent, pool: activePool, priorityFeeSol: activePriorityFeeSol, knownBalanceSol, attempt: attempts, signalObservedAt, entryGuard });
      onExecutionDiagnostics?.(result.diagnostics);
      return result.signature;
    } catch (caught) {
      // Pump and PumpSwap reuse numeric Anchor error codes. Fetch the program
      // logs before classification so PumpSwap 6004 becomes a slippage retry,
      // never a mislabeled bonding-curve routing failure.
      const classifiedError = caught instanceof LiveTradeError ? await enrichLiveTradeError(caught) : caught;
      const rawMessage = tradeErrorText(classifiedError);
      if (!routeFallbackUsed && activePool !== "auto" && isStalePoolRoutingError(rawMessage)) {
        routeFallbackUsed = true;
        // Migration orders must stay pinned to PumpSwap. Give the upstream
        // index a moment to catch up, then rebuild without ever submitting a
        // transaction that references the completed bonding-curve program.
        activePool = requestedPool === "pump-amm" ? "pump-amm" : "auto";
        if (activePool === "pump-amm") await new Promise((resolve) => setTimeout(resolve, 150));
        continue;
      }
      let retryWindowStillValid = true;
      if (freshRetriesUsed < freshTransactionRetries && isRetryableLiveTradeFailure(classifiedError) && shouldRetryFreshTransaction) {
        try {
          retryWindowStillValid = await shouldRetryFreshTransaction();
        } catch {
          retryWindowStillValid = false;
        }
      }
      const canRetry = freshRetriesUsed < freshTransactionRetries
        && isRetryableLiveTradeFailure(classifiedError)
        && retryWindowStillValid;
      if (canRetry) {
        freshRetriesUsed += 1;
        onFreshTransactionRetry?.(freshRetriesUsed + 1, diagnosticsFrom(classifiedError));
        continue;
      }
      if (classifiedError instanceof LiveTradeError) {
        classifiedError.attempts = attempts;
        throw classifiedError;
      }
      throw classifiedError;
    }
  }
}

// FIX: paper simulation now builds against "pump-amm", matching what Migration
// Live actually forces (see buildSignAndSendTrade calls with pool: "pump-amm"
// in lockstep-app.tsx). Previously this always used "auto", which never
// exercises the stale-pool-routing failure mode (Custom:6001/6004) that live
// migration trades are specifically exposed to. Paper results now reflect the
// same routing risk live trades face, instead of testing an easier path.
// Priority fee here stays fixed at the default: this build is never submitted
// on-chain, so there is no race to bid into.
export async function buildExactPaperBuy({ publicKey, mint, amountSol, slippagePercent, priorityFeeSol = DEFAULT_PRIORITY_FEE_SOL }: { publicKey: string; mint: string; amountSol: number; slippagePercent: number; priorityFeeSol?: number }): Promise<PaperBuyBuild> {
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
      priorityFee: Math.min(MAX_LIVE_PRIORITY_FEE_SOL, Math.max(0.000001, priorityFeeSol)),
      pool: "pump-amm",
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
    if (status?.err) {
      throw new LiveTradeError(`Transaction failed on-chain: ${stringifyTradeError(status.err)}`, {
        signature,
        rawError: status.err,
        confirmedOnChainFailure: true,
      });
    }
    if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") return;
    await new Promise((resolve) => setTimeout(resolve, 750));
  }
  throw new LiveTradeError(`Transaction confirmation timed out: ${signature}`, { signature });
}

export async function fetchPumpPrice(mint: string, signal?: AbortSignal) {
  const response = await fetch(`/api/price?mint=${encodeURIComponent(mint)}`, { cache: "no-store", signal });
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
  // FIX: pump.fun does not consistently expose Mayhem status under
  // boost_mode/boostMode. Legacy tags (e.g. "Mayhem Classic", seen on
  // BSTONK) can live under a differently-named or differently-cased field,
  // which previously made isMayhemMode silently evaluate to false and let a
  // known-Mayhem coin pass verifyMigrationCandidate as a standard migration.
  // This now checks several plausible field names, then falls back to
  // scanning the raw API payload text for "mayhem" as a safety net so an
  // unrecognized field shape still trips the filter instead of passing
  // through unnoticed.
  const boostModeRaw = coin.boost_mode ?? coin.boostMode ?? coin.boost_type ?? coin.boostType
    ?? coin.launch_mode ?? coin.launchMode ?? coin.mode ?? coin.pool_type ?? coin.poolType
    ?? coin.launchpad ?? coin.launchpad_type ?? "";
  const boostMode = typeof boostModeRaw === "string" ? boostModeRaw.trim().toUpperCase() : "";
  let rawPayloadContainsMayhem = false;
  try {
    rawPayloadContainsMayhem = JSON.stringify(coin).toLowerCase().includes("mayhem");
  } catch { /* ignore stringify failures, fall through to field-based checks only */ }
  const isMayhemMode = coin.is_mayhem_mode === true
    || coin.isMayhemMode === true
    || boostMode.includes("MAYHEM")
    || rawPayloadContainsMayhem;
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
) {
  const seen = new Set<string>();
  let socket: WebSocket | null = null;
  let stopped = false;
  let reconnectTimer: number | null = null;
  let reconnectAttempt = 0;

  const send = (payload: Record<string, unknown>) => {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
  };

  type TradeListener = {
    onTrade: (mark: LaunchCandidate) => void;
    onStatus?: (status: TokenTradeStreamStatus) => void;
    onProcessedSignal?: () => void;
  };
  const tradeListeners = new Map<string, Set<TradeListener>>();
  let activeTradeStream: EventSource | null = null;
  let pendingTradeStream: EventSource | null = null;
  let tradeStreamRevision = 0;
  let tradeStreamRebuildTimer: number | null = null;
  let tradeStreamFailureTimer: number | null = null;

  const notifyTradeStatus = (status: TokenTradeStreamStatus) => {
    tradeListeners.forEach((listeners) => listeners.forEach((listener) => listener.onStatus?.(status)));
  };

  const handleTradeFrame = (event: MessageEvent) => {
    try {
      const data = JSON.parse(String(event.data)) as Record<string, unknown>;
      const mint = typeof data.mint === "string" ? data.mint : "";
      const listeners = tradeListeners.get(mint);
      if (data.signalOnly === true && data.source === "helius-processed") {
        listeners?.forEach((listener) => listener.onProcessedSignal?.());
        return;
      }
      const marketCapSol = Number(data.marketCapSol);
      const marketCapUsd = Number(data.marketCapUsd);
      // subscribeTokenTrade covers every venue for a mint. Migration mode
      // must never react to bonding-curve trades, including frames queued
      // around the exact moment the curve completes.
      if (!listeners?.size || !isPostMigrationTradePool(data.pool)
        || !Number.isFinite(marketCapSol) || marketCapSol <= 0) return;
      const mark: LaunchCandidate = {
        mint,
        symbol: typeof data.symbol === "string" ? data.symbol : "MIG",
        name: typeof data.name === "string" ? data.name : "Migrated token",
        priceSol: marketCapSol / 1_000_000_000,
        marketCapSol,
        marketCapUsd: Number.isFinite(marketCapUsd) && marketCapUsd > 0 ? marketCapUsd : undefined,
        observedAt: Date.now(),
        observationSource: "trade-stream",
        observationPool: String(data.pool),
      };
      listeners.forEach((listener) => listener.onTrade(mark));
    } catch { /* ignore malformed relay frames */ }
  };

  // All active migration watches share one browser SSE connection. When the
  // mint set changes, open the replacement first and only then close the old
  // stream so a newly migrated token does not create a detection blind spot.
  const rebuildTradeStream = () => {
    tradeStreamRebuildTimer = null;
    const mints = [...tradeListeners.keys()];
    if (mints.length === 0) {
      tradeStreamRevision += 1;
      if (tradeStreamFailureTimer !== null) window.clearTimeout(tradeStreamFailureTimer);
      tradeStreamFailureTimer = null;
      pendingTradeStream?.close();
      activeTradeStream?.close();
      pendingTradeStream = null;
      activeTradeStream = null;
      return;
    }

    const revision = ++tradeStreamRevision;
    pendingTradeStream?.close();
    const params = new URLSearchParams();
    mints.forEach((mint) => params.append("mint", mint));
    const nextStream = new EventSource(`/api/pumpportal-trades?${params.toString()}`);
    pendingTradeStream = nextStream;
    notifyTradeStatus("connecting");
    nextStream.addEventListener("message", handleTradeFrame);
    nextStream.addEventListener("open", () => {
      const isPendingStream = pendingTradeStream === nextStream;
      const isActiveReconnect = activeTradeStream === nextStream;
      if (revision !== tradeStreamRevision || (!isPendingStream && !isActiveReconnect)) {
        nextStream.close();
        return;
      }
      if (tradeStreamFailureTimer !== null) window.clearTimeout(tradeStreamFailureTimer);
      tradeStreamFailureTimer = null;
      if (isActiveReconnect) {
        notifyTradeStatus("live");
        return;
      }
      const previousStream = activeTradeStream;
      activeTradeStream = nextStream;
      pendingTradeStream = null;
      previousStream?.close();
      notifyTradeStatus("live");
    });
    nextStream.addEventListener("error", () => {
      if (revision !== tradeStreamRevision || (pendingTradeStream !== nextStream && activeTradeStream !== nextStream)) return;
      notifyTradeStatus("connecting");
      if (tradeStreamFailureTimer === null) {
        tradeStreamFailureTimer = window.setTimeout(() => {
          tradeStreamFailureTimer = null;
          notifyTradeStatus("error");
        }, TRADE_STREAM_FAILURE_GRACE_MS);
      }
      if (pendingTradeStream === nextStream) {
        pendingTradeStream = null;
        nextStream.close();
        if (tradeStreamRebuildTimer === null) tradeStreamRebuildTimer = window.setTimeout(rebuildTradeStream, 1_000);
      }
    });
  };

  const scheduleTradeStreamRebuild = () => {
    if (tradeStreamRebuildTimer !== null) window.clearTimeout(tradeStreamRebuildTimer);
    tradeStreamRebuildTimer = window.setTimeout(rebuildTradeStream, 50);
  };

  // Metered token trades are relayed by our server so the funded PumpPortal
  // key never reaches a visitor's browser. The shared stream prevents one
  // five-minute connection per watched coin from exhausting the per-IP cap.
  const watchTokenTrades: TokenTradeWatcher = (mint, onTrade, onStatus, onProcessedSignal) => {
    const listener: TradeListener = { onTrade, onStatus, onProcessedSignal };
    let listeners = tradeListeners.get(mint);
    if (!listeners) {
      listeners = new Set();
      tradeListeners.set(mint, listeners);
    }
    listeners.add(listener);
    onStatus?.("connecting");
    scheduleTradeStreamRebuild();

    let removed = false;
    return () => {
      if (removed) return;
      removed = true;
      const current = tradeListeners.get(mint);
      current?.delete(listener);
      if (current?.size === 0) tradeListeners.delete(mint);
      scheduleTradeStreamRebuild();
    };
  };

  const handleMessage = (event: MessageEvent) => {
    try {
      const data = JSON.parse(String(event.data)) as Record<string, unknown>;
      const mint = typeof data.mint === "string" ? data.mint : "";
      if (!mint) return;
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
    const nextSocket = new WebSocket("wss://pumpportal.fun/api/data");
    socket = nextSocket;
    nextSocket.addEventListener("open", () => {
      if (stopped || socket !== nextSocket) return;
      reconnectAttempt = 0;
      onStatus("live");
      send({ method: "subscribeMigration" });
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
    if (tradeStreamRebuildTimer !== null) window.clearTimeout(tradeStreamRebuildTimer);
    if (tradeStreamFailureTimer !== null) window.clearTimeout(tradeStreamFailureTimer);
    pendingTradeStream?.close();
    activeTradeStream?.close();
    tradeListeners.clear();
    socket?.close();
    socket = null;
  };
}
