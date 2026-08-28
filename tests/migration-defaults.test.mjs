import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const sourceUrl = new URL("../app/lockstep-app.tsx", import.meta.url);
const tradingSourceUrl = new URL("../app/trading.ts", import.meta.url);
const relayRouteSourceUrl = new URL("../app/api/pumpportal-trades/route.ts", import.meta.url);
const relaySourceUrl = new URL("../app/api/pumpportal-trades/relay.ts", import.meta.url);
const persistentRelaySourceUrl = new URL("../relay/server.mjs", import.meta.url);
const rpcRouteSourceUrl = new URL("../app/api/rpc/route.ts", import.meta.url);

test("Migration Paper starts from its confirmed defaults instead of legacy settings", async () => {
  const source = await readFile(sourceUrl, "utf8");
  const tradingSource = await readFile(tradingSourceUrl, "utf8");

  assert.match(source, /buyAmount:\s*5,/);
  assert.match(source, /buyAmount:\s*5,\s*\n\s*slippage:\s*50,/);
  assert.match(source, /takeProfit:\s*300,/);
  assert.match(source, /paperStartingBalance:\s*10,/);
  assert.match(source, /boostEntryMinMarketCapUsd:\s*1600,/);
  assert.match(source, /boostEntryMarketCapUsd:\s*3500,/);
  assert.match(source, /boostMaximumFillMarketCapUsd:\s*4700,/);
  assert.match(source, /boostReboundPercent:\s*6,/);
  assert.match(source, /boostHardExitEnabled:\s*true,/);
  assert.match(source, /boostMinimumRemainingSeconds:\s*60,/);
  assert.match(source, /buyPriorityFeeSol:\s*0\.01,/);
  assert.match(source, /sellPriorityFeeSol:\s*0\.001,/);
  assert.match(source, /lockstep\.settings\.migration\.v14/);
  assert.match(source, /lockstep\.settings\.migration-live\.v2/);
  assert.match(source, /useState\(migrationDefaults\.paperStartingBalance\)/);
  assert.match(source, /rawMigrationSettings \? JSON\.parse\(rawMigrationSettings\) : \{\}/);
  assert.doesNotMatch(source, /rawMigrationSettings \? JSON\.parse\(rawMigrationSettings\) : legacySettings/);
  assert.match(source, /const executableBuyAmount = migrationExecutionSettings\.buyAmount/);
  assert.match(source, /Exact \$\{executableBuyAmount\.toFixed\(4\)\} SOL transaction could not be built/);
  assert.match(source, /reachesDipRebound/);
  assert.match(source, /lowestObservedMarketCapUsd/);
  assert.match(source, /reboundPercent < requiredReboundPercent/);
  assert.match(source, /marketCapUsd >= migrationExecutionSettings\.boostEntryMinMarketCapUsd/);
  assert.match(source, /outside \$\{rugTriggerLabel\}/);
  assert.match(source, /Processed WebSocket \+ shared trade stream \+ backup polling/);
  assert.doesNotMatch(source, /PUMPPORTAL API KEY/);
  assert.doesNotMatch(source, /PUMPPORTAL_API_KEY/);
  assert.match(source, /nextSliceAt: completedAt \+ current\.paperExitPlan\.intervalSeconds \* 1000/);
  assert.match(source, /nextSliceAt: attemptedAt \+ 2_000/);
  assert.match(source, /if \(migrationLiveSettings\.boostHardExitEnabled\) void closeLivePosition/);
  assert.match(source, /if \(migrationSettings\.boostHardExitEnabled\) closePaperPosition/);
  assert.match(source, /role="switch"/);
  assert.match(source, /Full exit after five minutes/);
  assert.match(source, /const entryDeadline = watchDeadline - minimumBoostRemainingSeconds \* 1000/);
  assert.match(source, /while \(Date\.now\(\) < entryDeadline/);
  assert.match(source, /latestSubmitAt:\s*entryDeadline/);
  assert.match(source, /minimumRemainingSeconds:\s*minimumBoostRemainingSeconds/);
  assert.match(source, /label="Stop new entries with"/);
  assert.match(source, /label="Buy after rebound"/);
  assert.match(source, /setMigrationValue\("boostMinimumRemainingSeconds", value\)/);
  assert.match(tradingSource, /Date\.now\(\) >= entryGuard\.latestSubmitAt/);
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
  assert.match(source, /TRADE_STREAM_FAILURE_GRACE_MS/);
  assert.match(source, /isActiveReconnect/);
  assert.match(source, /notifyTradeStatus\("connecting"\)/);
  assert.match(source, /mints\.forEach\(\(mint\) => params\.append\("mint", mint\)\)/);
  assert.doesNotMatch(source, /PUMPPORTAL_API_KEY/);
  assert.equal((source.match(/new WebSocket/g) ?? []).length, 2);
  assert.match(source, /const watchTokenTrades: TokenTradeWatcher =/);
  assert.match(source, /isPostMigrationTradePool\(data\.pool\)/);
  assert.match(source, /observationSource: "trade-stream"/);
  assert.match(source, /data\.signalOnly === true && data\.source === "helius-processed"/);
  assert.match(routeSource, /process\.env\.PUMPPORTAL_API_KEY/);
  assert.match(routeSource, /MAX_STREAMS_PER_IP/);
  assert.match(routeSource, /const MAX_STREAMS_PER_IP = 32/);
  assert.match(routeSource, /briefly overlaps the old/);
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
  assert.match(source, /method: "logsSubscribe"/);
  assert.match(source, /commitment: "processed"/);
  assert.match(source, /signalOnly: true/);
  assert.match(source, /SOLANA_WS_URL/);
});

test("Fresh per-token trades trigger immediately and USD market cap falls back to SOL", async () => {
  const source = await readFile(sourceUrl, "utf8");
  const tradingSource = await readFile(tradingSourceUrl, "utf8");

  assert.match(source, /function marketCapUsdFor/);
  assert.match(source, /marketCapSol \* solUsdPrice/);
  assert.match(source, /triggerCandidate = \{\s*\.\.\.candidate,\s*\.\.\.streamedMark,/);
  assert.match(source, /observationSource: Date\.now\(\) - processedSignalAt <= LIVE_QUOTE_MAX_AGE_MS \? "processed-signal" : "poll"/);
  assert.match(source, /confirmedPostMigrationPoll = mark\.complete/);
  assert.match(source, /Boolean\(mark\.poolAddress\)/);
  assert.match(source, /triggerReceipt/);
  assert.match(source, /Low \$\{formatUsdMarketCap\(triggerLowMarketCapUsd\)\}/);
  assert.match(source, /getConfirmedBuyFill/);
  assert.match(source, /confirmed fill/);
  assert.match(source, /maximumEntryMarketCapUsd:\s*migrationExecutionSettings\.boostEntryMarketCapUsd/);
  assert.match(source, /maximumFillMarketCapUsd:\s*migrationExecutionSettings\.boostMaximumFillMarketCapUsd/);
  assert.match(source, /minimumMarketCapUsd:\s*migrationExecutionSettings\.boostEntryMinMarketCapUsd/);
  assert.match(source, /reportedMarketCapUsd:\s*triggerMarketCapUsd/);
  assert.match(source, /Low \$\{formatUsdMarketCap\(triggerLowMarketCapUsd\)\}/);
  assert.match(tradingSource, /effectiveQuoteReserveLamports = poolQuoteAmount\.add\(pool\.virtualQuoteReserves\)/);
  assert.match(tradingSource, /verifiedMarketCapUsd < entryGuard\.minimumMarketCapUsd/);
  assert.match(tradingSource, /verifiedMarketCapUsd > entryGuard\.maximumEntryMarketCapUsd/);
  assert.match(tradingSource, /Verified on-chain MC/);
  assert.match(tradingSource, /projectedFillMarketCapUsd \/ verifiedMarketCapUsd/);
  assert.match(tradingSource, /Projected average fill/);
  assert.match(tradingSource, /exceeds the \$\$\{entryGuard\.maximumFillMarketCapUsd\.toFixed\(0\)\} MC fill maximum/);
  assert.match(tradingSource, /minimumMarketCapBaseAmountOut\.gt\(slippageMinBaseAmountOut\)/);
  assert.match(tradingSource, /totalSupplyTokens = Number\(state\.baseMintAccount\.supply\.toString\(\)\) \/ baseUnitScale/);
  assert.match(tradingSource, /minimumTokensOut = amountSol \* totalSupplyTokens \* entryGuard\.solUsdPrice \/ entryGuard\.maximumFillMarketCapUsd/);
  assert.match(source, /label="Entry maximum"/);
  assert.match(source, /label="Maximum average fill"/);
  assert.doesNotMatch(source, /Maximum entry impact/);
  assert.match(tradingSource, /Entry protection could not verify a fresh PumpSwap fill/);
  assert.match(source, /Live entry protected/);
  assert.match(source, /instanceof LiveTradeEntryGuardError/);
  assert.match(source, /PumpPortal live trade/);
  assert.match(source, /verified backup poll/);
  assert.match(source, /processed WebSocket signal/);
  assert.match(source, /freshTrigger/);
  assert.match(source, /watchTokenTrades\?\.\(\s*unverifiedCandidate\.mint/);
  assert.match(source, /live feed unavailable/);
  assert.match(source, /buffer frames while the/);
  assert.match(source, /streamedMarks\.length > 64/);
  assert.match(source, /streamedMarks\.shift\(\)/);
  assert.match(source, /Promise\.race\(\[pollResult, tradeInterrupt\.promise\]\)/);
  assert.match(source, /pollController\.abort\(\)/);
  assert.match(tradingSource, /fetchPumpPrice\(mint: string, signal\?: AbortSignal\)/);
  assert.match(source, /warmPumpSwapBuy\(candidate\.mint, keypairRef\.current\.publicKey\)/);
  assert.match(source, /warmPumpSwapSell\(livePosition\.mint, signingKeypair\.publicKey\)/);
  assert.match(source, /setInterval\(warmOpenMigrationExits, 10_000\)/);
  assert.match(tradingSource, /export function warmPumpSwapSell/);
  assert.match(tradingSource, /fetch\("\/api\/trade", \{ method: "GET", cache: "no-store" \}\)/);
  assert.match(source, /streamedMark\.symbol === "MIG" \? candidate\.symbol/);
  assert.match(tradingSource, /buildLocalPumpSwapBuyTransaction/);
  assert.match(tradingSource, /prepareRecentBlockhash/);
  assert.match(tradingSource, /RECENT_BLOCKHASH_PREPARATION_TTL_MS/);
  assert.match(tradingSource, /PUMP_AMM_SDK\.buyInstructions/);
  assert.match(tradingSource, /"buyExactQuoteIn"/);
  assert.match(tradingSource, /spendableQuoteIn/);
  assert.match(tradingSource, /minBaseAmountOut/);
  assert.match(tradingSource, /knownBalanceSol/);
  assert.match(source, /Date\.now\(\) - Number\(triggerCandidate\.observedAt\) <= LIVE_QUOTE_MAX_AGE_MS/);
  assert.doesNotMatch(source, /const retryMark = await fetchPumpPrice\(candidate\.mint\)/);
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

test("Live execution broadcasts one signed transaction across RPC routes and records phase timings", async () => {
  const source = await readFile(sourceUrl, "utf8");
  const tradingSource = await readFile(tradingSourceUrl, "utf8");
  const rpcRouteSource = await readFile(rpcRouteSourceUrl, "utf8");

  assert.match(rpcRouteSource, /body\.method === "sendTransaction"/);
  assert.match(rpcRouteSource, /id: requestId/);
  assert.match(rpcRouteSource, /body\.id \?\? 1/);
  assert.match(rpcRouteSource, /Promise\.any\(submissions\)/);
  assert.match(rpcRouteSource, /routesAttempted: RPC_URLS\.length/);
  assert.match(rpcRouteSource, /same Solana signature/);
  assert.match(tradingSource, /type LiveExecutionDiagnostics/);
  assert.match(tradingSource, /signal→send/);
  assert.match(tradingSource, /build \$\{formatDuration\(detail\.buildMs\)\}/);
  assert.match(tradingSource, /submit \$\{formatDuration\(detail\.submitMs\)\} via \$\{route\}/);
  assert.match(tradingSource, /onExecutionDiagnostics/);
  assert.match(tradingSource, /builderFallbackReason/);
  assert.match(source, /formatLiveExecutionDiagnostics\(diagnostics\)/g);
  assert.match(source, /signalObservedAt: Number\(triggerCandidate\.observedAt/);
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
  assert.match(tradingSource, /DEFAULT_PRIORITY_FEE_SOL = 0\.01/);
  assert.match(tradingSource, /MIN_LIVE_PRIORITY_FEE_SOL = 0\.01/);
  assert.match(tradingSource, /MAX_LIVE_PRIORITY_FEE_SOL = 0\.06/);
  assert.match(tradingSource, /getCachedCompetitivePriorityFeeSol\(\)/);
  assert.match(tradingSource, /priorityFeeSol\?: number/);
  assert.match(tradingSource, /activePriorityFeeSol/);
  assert.match(source, /priorityFeeSol:\s*migrationExecutionSettings\.buyPriorityFeeSol/);
  assert.match(source, /priorityFeeSol:\s*migrationLiveSettings\.sellPriorityFeeSol/);
  assert.match(source, /label="Buy priority fee"/);
  assert.match(source, /label="Sell priority fee"/);
  assert.match(tradingSource, /export function warmLiveTradePreparation/);
  assert.doesNotMatch(tradingSource, /priorityFeeSol = await fetchCompetitivePriorityFeeSol/);
  assert.match(source, /if \(unlocked\) warmLiveTradePreparation\(\)/);
});
