import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const sourceUrl = new URL("../app/lockstep-app.tsx", import.meta.url);
const tradingSourceUrl = new URL("../app/trading.ts", import.meta.url);
const relayRouteSourceUrl = new URL("../app/api/pumpportal-trades/route.ts", import.meta.url);
const relaySourceUrl = new URL("../app/api/pumpportal-trades/relay.ts", import.meta.url);
const persistentRelaySourceUrl = new URL("../relay/server.mjs", import.meta.url);

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
  assert.match(source, /Shared live stream \+ backup polling/);
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

test("Migration feed consumes the protected server relay for metered token trades", async () => {
  const source = await readFile(tradingSourceUrl, "utf8");
  const routeSource = await readFile(relayRouteSourceUrl, "utf8");
  const relaySource = await readFile(relaySourceUrl, "utf8");

  assert.match(source, /new EventSource\(`\/api\/pumpportal-trades\?\$\{params\.toString\(\)\}`\)/);
  assert.equal((source.match(/new EventSource/g) ?? []).length, 1);
  assert.match(source, /const tradeListeners = new Map/);
  assert.match(source, /mints\.forEach\(\(mint\) => params\.append\("mint", mint\)\)/);
  assert.doesNotMatch(source, /PUMPPORTAL_API_KEY/);
  assert.equal((source.match(/new WebSocket/g) ?? []).length, 2);
  assert.match(source, /const watchTokenTrades: TokenTradeWatcher =/);
  assert.match(source, /isPostMigrationTradePool\(data\.pool\)/);
  assert.match(source, /observationSource: "trade-stream"/);
  assert.match(routeSource, /process\.env\.PUMPPORTAL_API_KEY/);
  assert.match(routeSource, /MAX_STREAMS_PER_IP/);
  assert.match(routeSource, /MAX_MINTS_PER_STREAM/);
  assert.match(routeSource, /searchParams\.getAll\("mint"\)/);
  assert.match(routeSource, /MAX_STARTS_PER_MINUTE/);
  assert.match(routeSource, /MAX_TRACKED_IPS/);
  assert.match(routeSource, /text\/event-stream/);
  assert.match(routeSource, /process\.env\.PUMPPORTAL_RELAY_URL/);
  assert.match(routeSource, /process\.env\.PUMPPORTAL_RELAY_SECRET/);
  assert.match(routeSource, /authorization: `Bearer \$\{relaySecret\}`/);
  assert.match(relaySource, /MAX_ACTIVE_TOKENS/);
  assert.match(relaySource, /MAX_LISTENERS_PER_TOKEN/);
  assert.match(relaySource, /subscribeTokenTrade/);
  assert.match(relaySource, /unsubscribeTokenTrade/);
  assert.match(relaySource, /lockstepPumpPortalRelay/);
  assert.match(relaySource, /pool: typeof data\.pool === "string"/);
});

test("Persistent relay keeps one protected PumpPortal connection warm", async () => {
  const source = await readFile(persistentRelaySourceUrl, "utf8");

  assert.match(source, /relay\.start\(\)/);
  assert.match(source, /subscribeMigration/);
  assert.match(source, /subscribeTokenTrade/);
  assert.match(source, /unsubscribeTokenTrade/);
  assert.match(source, /LOCKSTEP_RELAY_SECRET/);
  assert.match(source, /timingSafeEqual/);
  assert.match(source, /url\.pathname === "\/health"/);
  assert.match(source, /url\.pathname !== "\/trades"/);
  assert.match(source, /url\.searchParams\.getAll\("mint"\)/);
});

test("Fresh per-token trades trigger immediately and USD market cap falls back to SOL", async () => {
  const source = await readFile(sourceUrl, "utf8");

  assert.match(source, /function marketCapUsdFor/);
  assert.match(source, /marketCapSol \* solUsdPrice/);
  assert.match(source, /triggerCandidate = \{ \.\.\.candidate, \.\.\.streamedMark, marketCapUsd: streamedMarketCapUsd \}/);
  assert.match(source, /observationSource: "poll"/);
  assert.match(source, /confirmedPostMigrationPoll = mark\.complete/);
  assert.match(source, /Boolean\(mark\.poolAddress\)/);
  assert.match(source, /triggerReceipt/);
  assert.match(source, /PumpPortal live trade/);
  assert.match(source, /verified backup poll/);
  assert.match(source, /freshTrigger/);
  assert.match(source, /watchTokenTrades\?\.\(\s*unverifiedCandidate\.mint/);
  assert.match(source, /live feed unavailable/);
  assert.match(source, /buffer frames while the/);
  assert.match(source, /Date\.now\(\) - Number\(triggerCandidate\.observedAt\) <= LIVE_QUOTE_MAX_AGE_MS/);
  assert.doesNotMatch(source, /stream-confirm:/);
  assert.doesNotMatch(source, /After execution latency/);
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

test("Completed bonding curves are treated as stale pre-migration routes", async () => {
  const source = await readFile(tradingSourceUrl, "utf8");

  assert.match(source, /BondingCurveComplete/);
  assert.match(source, /liquidity migrated/);
  assert.match(source, /6EF8rrecthR5Dkzon8Nwu78rvF6kCUKqJ4M5uBEwF6P/);
  assert.match(source, /transaction\.message\.staticAccountKeys/);
  assert.match(source, /activePool = requestedPool === "pump-amm" \? "pump-amm" : "auto"/);
  assert.match(source, /isPumpSwapSlippageError/);
  assert.match(source, /pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA/);
  assert.match(source, /custom program error: 0x1774/);
  assert.match(source, /classifiedError = caught instanceof LiveTradeError \? await enrichLiveTradeError\(caught\) : caught/);
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
