import eventBus from '../core/events';
import MarketDataWebSocketClient from '../modules/market-data/client/websocket.client';
import ConnectionManager from '../modules/market-data/managers/connection.manager';
import {
  MarketDataSubscriptionMode,
  default as SubscriptionManager,
} from '../modules/market-data/managers/subscription.manager';
import {
  MarketDepthEvent,
  MarketGreeksEvent,
  MarketTickEvent,
  default as TickProcessor,
} from '../modules/market-data/processors/tick.processor';
import ProtobufDecoder from '../modules/market-data/protobuf/protobuf.decoder';

const instrumentKeys = ['NSE_INDEX|Nifty 50', 'NSE_INDEX|Nifty Bank', 'BSE_INDEX|SENSEX'];

function printTick(event: MarketTickEvent): void {
  console.log(
    `[market.tick] ${event.instrumentKey} | LTP: ${event.ltp ?? '-'} | ` +
      `Close: ${event.closePrice ?? '-'} | Time: ${event.lastTradedTime ?? event.timestamp ?? '-'}`
  );
}

function printGreeks(event: MarketGreeksEvent): void {
  console.log(
    `[market.greeks] ${event.instrumentKey} | Delta: ${event.delta ?? '-'} | ` +
      `Theta: ${event.theta ?? '-'} | Gamma: ${event.gamma ?? '-'} | ` +
      `Vega: ${event.vega ?? '-'} | Rho: ${event.rho ?? '-'}`
  );
}

function printDepth(event: MarketDepthEvent): void {
  const bestQuote = event.quotes[0];
  console.log(
    `[market.depth] ${event.instrumentKey} | Levels: ${event.quotes.length} | ` +
      `Best bid: ${bestQuote?.bidPrice ?? '-'} (${bestQuote?.bidQuantity ?? '-'}) | ` +
      `Best ask: ${bestQuote?.askPrice ?? '-'} (${bestQuote?.askQuantity ?? '-'})`
  );
}

async function run(): Promise<void> {
  const accessToken = process.env.UPSTOX_ACCESS_TOKEN?.trim();
  if (!accessToken) {
    throw new Error('Set UPSTOX_ACCESS_TOKEN in the environment before running this integration test.');
  }

  const webSocketClient = new MarketDataWebSocketClient(accessToken);
  const connectionManager = new ConnectionManager(accessToken, webSocketClient);
  const subscriptionManager = new SubscriptionManager(accessToken, connectionManager);
  const protobufDecoder = new ProtobufDecoder();
  const tickProcessor = new TickProcessor();
  let shuttingDown = false;

  eventBus.on('market.tick', printTick);
  eventBus.on('market.greeks', printGreeks);
  eventBus.on('market.depth', printDepth);

  webSocketClient.on('message', (buffer: Buffer) => {
    try {
      tickProcessor.process(protobufDecoder.decode(buffer));
    } catch (error) {
      console.error('Failed to decode or publish a market data message.', error);
    }
  });

  const shutdown = (): void => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    console.log('\nDisconnecting from the Upstox market data feed...');
    subscriptionManager.unsubscribeMany(instrumentKeys);
    connectionManager.disconnect();

    setTimeout(() => process.exit(0), 1_000).unref();
  };

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  console.log('Connecting to the Upstox market data feed...');
  await subscriptionManager.subscribeMany(instrumentKeys, MarketDataSubscriptionMode.FULL);
  console.log('Subscribed to NIFTY, BANKNIFTY, and SENSEX. Press Ctrl+C to stop.');
}

run().catch((error) => {
  console.error('Market data integration test failed.', error);
  process.exitCode = 1;
});
