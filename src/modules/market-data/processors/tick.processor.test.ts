import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'events';
import TickProcessor, { MarketDepthEvent, MarketGreeksEvent, MarketTickEvent } from './tick.processor';

function fullFeed() {
  return {
    type: 'live_feed' as const,
    currentTs: '1723618200000',
    feeds: {
      'NSE_FO|45102': {
        fullFeed: {
          marketFF: {
            ltpc: { ltp: 123.45, ltt: '1723618199000', ltq: '10', cp: 120 },
            marketLevel: { bidAskQuote: [{ bidP: 123, bidQ: '10', askP: 124, askQ: '12' }] },
            optionGreeks: { delta: .5 },
          },
        },
      },
    },
  };
}

test('normalizes one epoch-millisecond packet once for tick, depth, and greeks while preserving generation', () => {
  const bus = new EventEmitter(); const ticks: MarketTickEvent[] = []; const depths: MarketDepthEvent[] = []; const greeks: MarketGreeksEvent[] = [];
  bus.on('market.tick', (event) => ticks.push(event)); bus.on('market.depth', (event) => depths.push(event)); bus.on('market.greeks', (event) => greeks.push(event));
  new TickProcessor(bus).process(fullFeed(), 7);
  const timestamp = '2024-08-14T06:50:00.000Z';
  assert.equal(ticks.length, 1); assert.equal(depths.length, 1); assert.equal(greeks.length, 1);
  assert.equal(ticks[0].timestamp, timestamp); assert.equal(depths[0].timestamp, timestamp); assert.equal(greeks[0].timestamp, timestamp);
  assert.equal(ticks[0].lastTradedTime, '2024-08-14T06:49:59.000Z');
  assert.equal(ticks[0].generationId, 7); assert.equal(depths[0].generationId, 7); assert.equal(greeks[0].generationId, 7);
});

test('canonicalizes valid ISO source timestamps without changing the generation', () => {
  const bus = new EventEmitter(); const ticks: MarketTickEvent[] = []; bus.on('market.tick', (event) => ticks.push(event));
  new TickProcessor(bus).process({ type: 'live_feed', currentTs: '2026-08-20T09:15:00+05:30', feeds: { NIFTY: { ltpc: { ltp: 24_300 } } } }, 19);
  assert.deepEqual(ticks, [{ instrumentKey: 'NIFTY', timestamp: '2026-08-20T03:45:00.000Z', ltp: 24_300, lastTradedTime: undefined, lastTradedQuantity: undefined, closePrice: undefined, generationId: 19 }]);
});

test('fails closed for invalid, seconds, and microseconds source timestamps without using receipt time', () => {
  const bus = new EventEmitter(); const ticks: MarketTickEvent[] = []; bus.on('market.tick', (event) => ticks.push(event));
  const processor = new TickProcessor(bus);
  for (const currentTs of ['invalid', '1723618200', '1723618200000000']) {
    processor.process({ type: 'live_feed', currentTs, feeds: { NIFTY: { ltpc: { ltp: 24_300 } } } }, 1);
  }
  assert.equal(ticks.length, 0);
});
