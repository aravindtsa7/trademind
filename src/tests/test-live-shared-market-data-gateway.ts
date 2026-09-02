/**
 * Combined V2 + V4 + V8 forward runtime through ONE shared Upstox market-data WebSocket.
 *
 * This is the proof path for the Shared Market Data Gateway milestone: instead of each strategy
 * process owning its own MarketDataWebSocketClient/ConnectionManager/SubscriptionManager (three
 * physical sockets today), this script constructs exactly ONE SharedMarketDataGateway, leases one
 * isolated GatewayMarketDataChannel per strategy, and runs V2/V4/V8's own existing, unmodified
 * `run()` entry points against those channels instead of their standalone dedicated market-data
 * triads. No strategy decision logic is duplicated or reimplemented here -- this file only wires
 * market-data infrastructure; V2/V4/V8's evaluator/orchestrator code is reused verbatim.
 *
 * Standalone diagnostics (`npm run paper:v2`, `npm run shadow:v4:momentum`,
 * `npm run shadow:v8:reclaim`) remain fully functional and unaffected -- they still construct
 * their own dedicated ConnectionManager/SubscriptionManager/MarketDataHealthMonitorService.
 */
import 'dotenv/config';
import SharedMarketDataGateway from '../modules/market-data/gateway/shared-market-data-gateway';
import { run as runV2, LiveRuntimeOptions as V2Options } from './test-live-paper-trading';
import { run as runV4 } from './test-live-v4-nifty-momentum-shadow';
import { run as runV8 } from './test-live-v8-nifty-bullish-reclaim-shadow';

const consumerLabels: Record<string, string> = {
  'paper:v2': 'V2',
  'shadow:v4:momentum': 'V4',
  'shadow:v8:reclaim': 'V8',
};

async function run(): Promise<void> {
  const accessToken = process.env.UPSTOX_ACCESS_TOKEN?.trim();
  if (!accessToken) throw new Error('UPSTOX_ACCESS_TOKEN must be set in .env before running the combined shared-market-data-gateway runtime.');

  // Matches what each strategy's own standalone CLI wrapper sets before importing it (see
  // test-live-paper-trading-v2.ts / test-live-v4-nifty-momentum-shadow-entry.ts /
  // test-live-v8-nifty-bullish-reclaim-shadow-entry.ts). PAPER_STRATEGY_ID is deliberately left
  // unset here -- it only affects one cosmetic V2 EOD log line (defaults to V2_TREND_DOWN_PE) and
  // would otherwise be ambiguous across three strategies sharing one process.
  process.env.PAPER_TRADING_ONLY = 'true'; // required by V8's own startup safety gate
  process.env.SHADOW_ONLY = 'true'; // required by V8's own startup safety gate
  if (!process.env.TRADING_LOG_MODE?.trim()) process.env.TRADING_LOG_MODE = 'TRADING';

  const gateway = new SharedMarketDataGateway({ accessToken });

  // Registration happens BEFORE the physical connect so the startup log makes the physical
  // ownership explicit and unambiguous: SHARED_MARKET_DATA_GATEWAY_STARTED consumerCount=3, then
  // exactly one physical CONNECTING/CONNECTED pair, only then each strategy's own startup.
  const v2Channel = gateway.registerConsumer('paper:v2');
  const v4Channel = gateway.registerConsumer('shadow:v4:momentum');
  const v8Channel = gateway.registerConsumer('shadow:v8:reclaim');
  const registeredChannels = [v2Channel, v4Channel, v8Channel];

  // Central runtime ownership of the physical disconnect (milestone invariant #8): only once
  // every registered consumer has released itself (its own EOD/fault/SIGINT close-out, which each
  // strategy already performs unchanged) does this runtime disconnect the shared transport.
  let shutdownStarted = false;
  gateway.on('consumerDeregistered', ({ remainingConsumers }: { remainingConsumers: number }) => {
    if (remainingConsumers > 0 || shutdownStarted) return;
    shutdownStarted = true;
    console.log('[SHARED_MARKET_DATA_GATEWAY] every consumer has finished; disconnecting the shared physical transport.');
    gateway.shutdown();
  });

  try {
    await gateway.start();
  } catch (error) {
    // F-03: gateway.start() itself never reached the physical CONNECTED state -- none of
    // V2/V4/V8's own run() has been invoked yet, so nothing owns these channels. Release every
    // registered consumer centrally rather than leaving them registered against a gateway that
    // will never finish starting.
    registeredChannels.forEach((channel) => channel.disconnect());
    throw error;
  }

  // F-01: explicit, per-instance V2 identity -- independent of process.env.TRADING_STRATEGY_VERSION,
  // which this combined runtime deliberately never sets (V4/V8 share this same process and must
  // never be able to observe/alter it). See LiveRuntimeOptions.strategyVersion in
  // test-live-paper-trading.ts for the full rationale.
  const options: V2Options = { channel: v2Channel, strategyVersion: 'V2' };
  const results = await Promise.allSettled([
    runV2(options),
    runV4({ channel: v4Channel }),
    runV8({ channel: v8Channel }),
  ]);

  // Each run() call above resolves once ITS OWN startup either reaches RUNNING, returns early
  // (market closed, warmup not fresh -- not a failure), or its host synchronously faults during
  // start() -- never when the strategy's live session actually ends. A running strategy's own
  // EOD/SIGINT/host-fault machinery (unchanged) keeps the process alive and eventually releases
  // its channel, exactly as it already does standalone.
  let anyFailedToStart = false;
  results.forEach((result, index) => {
    const consumerId = ['paper:v2', 'shadow:v4:momentum', 'shadow:v8:reclaim'][index];
    if (result.status === 'rejected') {
      anyFailedToStart = true;
      console.error(`[SHARED_MARKET_DATA_GATEWAY] ${consumerLabels[consumerId]} (${consumerId}) failed to start:`, result.reason instanceof Error ? result.reason.message : result.reason);
    }
  });

  console.log(`[SHARED_MARKET_DATA_GATEWAY_STARTED] consumerCount=${gateway.getActiveConsumerCount()} generationId=${gateway.getGenerationId()} physicalSubscriptions=${gateway.getPhysicalSubscriptionCount()}`);
  if (anyFailedToStart) {
    console.error('[SHARED_MARKET_DATA_GATEWAY] one or more strategies failed to start -- see the errors above. Strategies that started successfully continue running independently.');
  }
  console.log('Combined V2+V4+V8 shared-market-data-gateway runtime is up. Press Ctrl+C to stop every strategy.');
}

// Only auto-run as the CLI entry point (`npm run live:shared-gateway`).
if (require.main === module) {
  void run().catch((error) => {
    console.error('Combined shared-market-data-gateway runtime failed to start:', error instanceof Error ? error.message : 'Unknown error.');
    process.exitCode = 1;
  });
}

export { run };
