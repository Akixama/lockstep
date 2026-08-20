import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const sourceUrl = new URL("../app/lockstep-app.tsx", import.meta.url);
const tradingSourceUrl = new URL("../app/trading.ts", import.meta.url);

test("Migration Paper starts from its confirmed defaults instead of legacy settings", async () => {
  const source = await readFile(sourceUrl, "utf8");

  assert.match(source, /buyAmount:\s*5,/);
  assert.match(source, /buyAmount:\s*5,\s*\n\s*slippage:\s*50,/);
  assert.match(source, /takeProfit:\s*300,/);
  assert.match(source, /paperStartingBalance:\s*10,/);
  assert.match(source, /boostEntryMinMarketCapUsd:\s*1600,/);
  assert.match(source, /boostEntryMarketCapUsd:\s*2400,/);
  assert.match(source, /lockstep\.settings\.migration\.v14/);
  assert.match(source, /lockstep\.settings\.migration-live\.v2/);
  assert.match(source, /useState\(migrationDefaults\.paperStartingBalance\)/);
  assert.match(source, /rawMigrationSettings \? JSON\.parse\(rawMigrationSettings\) : \{\}/);
  assert.doesNotMatch(source, /rawMigrationSettings \? JSON\.parse\(rawMigrationSettings\) : legacySettings/);
  assert.match(source, /const executableBuyAmount = migrationExecutionSettings\.buyAmount/);
  assert.match(source, /Exact \$\{executableBuyAmount\.toFixed\(4\)\} SOL transaction could not be built/);
  assert.match(source, /crossedRugTrigger/);
  assert.match(source, /hasObservedAboveEntryBand/);
  assert.match(source, /streamedMarketCapUsd >= migrationExecutionSettings\.boostEntryMinMarketCapUsd/);
  assert.match(source, /marketCapUsd >= migrationExecutionSettings\.boostEntryMinMarketCapUsd/);
  assert.match(source, /outside \$\{rugTriggerLabel\}/);
  assert.match(source, /Live trades \+ backup polling/);
  assert.doesNotMatch(source, /PUMPPORTAL API KEY/);
  assert.doesNotMatch(source, /PUMPPORTAL_API_KEY/);
  assert.match(source, /nextSliceAt: completedAt \+ current\.paperExitPlan\.intervalSeconds \* 1000/);
  assert.match(source, /nextSliceAt: attemptedAt \+ 2_000/);
  assert.doesNotMatch(source, /nextSliceAt: current\.paperExitPlan\.nextSliceAt \+ current\.paperExitPlan\.intervalSeconds \* 1000/);
});

test("New Pairs quotes fresh launches from realtime bonding-curve reserves", async () => {
  const source = await readFile(sourceUrl, "utf8");
  const tradingSource = await readFile(tradingSourceUrl, "utf8");

  assert.match(tradingSource, /virtualSolReserves:\s*solReserve/);
  assert.match(tradingSource, /virtualTokenReserves:\s*tokenReserve/);
  assert.match(tradingSource, /fetchLiveBuyQuote\(candidate:\s*LaunchCandidate/);
  assert.match(source, /checking live \$\{adaptiveAmount\} SOL impact/);
  assert.doesNotMatch(source, /checking executable 0\.5 SOL quote/);
});

test("Migration Paper excludes Mayhem coins before opening a BOOST watch", async () => {
  const source = await readFile(tradingSourceUrl, "utf8");

  assert.match(source, /coin\.is_mayhem_mode === true/);
  assert.match(source, /if \(mark\.isMayhemMode\) throw new Error/);
});

test("Migration feed reuses one websocket for metered token-trade watches", async () => {
  const source = await readFile(tradingSourceUrl, "utf8");

  assert.match(source, /subscribeTokenTrade/);
  assert.match(source, /unsubscribeTokenTrade/);
  assert.match(source, /tradeListeners = new Map/);
  assert.equal((source.match(/new WebSocket/g) ?? []).length, 2);
  assert.match(source, /const watchTokenTrades: TokenTradeWatcher =/);
  assert.match(source, /observationSource: "trade-stream"/);
  assert.doesNotMatch(source, /streamKey \?/);
});

test("Fresh per-token trades trigger immediately and USD market cap falls back to SOL", async () => {
  const source = await readFile(sourceUrl, "utf8");

  assert.match(source, /function marketCapUsdFor/);
  assert.match(source, /marketCapSol \* solUsdPrice/);
  assert.match(source, /triggerCandidate = \{ \.\.\.candidate, \.\.\.streamedMark, marketCapUsd: streamedMarketCapUsd \}/);
  assert.match(source, /freshStreamTrigger/);
  assert.doesNotMatch(source, /stream-confirm:/);
});

test("Wallet backup requires local password confirmation before revealing a private key", async () => {
  const source = await readFile(sourceUrl, "utf8");

  assert.match(source, /await decryptWallet\(storedWallet, backupPassword\)/);
  assert.match(source, /bs58\.encode\(keypair\.secretKey\)/);
  assert.match(source, /anyone with this private key controls the wallet/i);
  assert.match(source, /30_000/);
  assert.match(source, /setRevealedPrivateKey\(""\)/);
});

test("Live entries rebuild only transactions confirmed failed on-chain", async () => {
  const source = await readFile(sourceUrl, "utf8");
  const tradingSource = await readFile(tradingSourceUrl, "utf8");

  assert.match(tradingSource, /class LiveTradeError extends Error/);
  assert.match(tradingSource, /confirmedOnChainFailure/);
  assert.match(tradingSource, /if \(!\(error instanceof LiveTradeError\) \|\| !error\.confirmedOnChainFailure\) return false/);
  assert.match(tradingSource, /freshTransactionRetries = 0/);
  assert.match(tradingSource, /shouldRetryFreshTransaction/);
  assert.match(tradingSource, /getTransaction/);
  assert.match(tradingSource, /error\.logs = transaction\?\.meta\?\.logMessages/);
  assert.match(source, /freshTransactionRetries: 2/g);
  assert.match(source, /fresh retries exhausted, still scanning/g);
  assert.match(source, /isRetryableLiveTradeFailure\(error\)/);
});

test("System Program insufficient-funds failures are explained and never retried", async () => {
  const source = await readFile(sourceUrl, "utf8");
  const tradingSource = await readFile(tradingSourceUrl, "utf8");

  assert.match(source, /LIVE_WALLET_RESERVE_SOL = 0\.015/);
  assert.match(tradingSource, /class LiveTradeFundingError extends Error/);
  assert.match(tradingSource, /simulateTransaction/);
  assert.match(tradingSource, /if \(error instanceof LiveTradeFundingError\) return false/);
  assert.match(tradingSource, /Program 11111111111111111111111111111111 failed: custom program error: 0x1/);
  assert.match(tradingSource, /deposit to at least/);
});

test("Live priority fee lookup is warmed outside the buy path", async () => {
  const source = await readFile(sourceUrl, "utf8");
  const tradingSource = await readFile(tradingSourceUrl, "utf8");

  assert.match(tradingSource, /PRIORITY_FEE_CACHE_MS/);
  assert.match(tradingSource, /getCachedCompetitivePriorityFeeSol\(\)/);
  assert.match(tradingSource, /export function warmLiveTradePreparation/);
  assert.doesNotMatch(tradingSource, /priorityFeeSol = await fetchCompetitivePriorityFeeSol/);
  assert.match(source, /if \(unlocked\) warmLiveTradePreparation\(\)/);
});
