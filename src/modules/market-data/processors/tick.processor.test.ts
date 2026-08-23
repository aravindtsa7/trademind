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

// B1: canonical live-source-timestamp boundary. TickProcessor's injected `now` is its
// packet-receive reference; a future currentTs must never reach any published event.
function fullFeedWithTs(currentTs: string) {
  return { type: 'live_feed' as const, currentTs, feeds: { 'NSE_FO|45102': { fullFeed: { marketFF: { ltpc: { ltp: 123.45 }, marketLevel: { bidAskQuote: [{ bidP: 123, bidQ: '10', askP: 124, askQ: '12' }] }, optionGreeks: { delta: 0.5 } } } } } };
}

test('B1-1/B1-5: a future ISO source timestamp at the live canonical boundary is rejected and publishes no tick, depth, or greeks', () => {
  const bus = new EventEmitter(); const ticks: MarketTickEvent[] = []; const depths: MarketDepthEvent[] = []; const greeks: MarketGreeksEvent[] = [];
  bus.on('market.tick', (event) => ticks.push(event)); bus.on('market.depth', (event) => depths.push(event)); bus.on('market.greeks', (event) => greeks.push(event));
  const receiveMs = Date.UTC(2026, 7, 20, 3, 45, 0);
  const processor = new TickProcessor(bus, () => receiveMs);
  processor.process(fullFeedWithTs('2026-08-20T09:16:00+05:30'), 7); // 1 minute after receiveMs
  assert.equal(ticks.length, 0); assert.equal(depths.length, 0); assert.equal(greeks.length, 0);
});

test('B1-2: a future epoch-millisecond source timestamp at the live canonical boundary is rejected', () => {
  const bus = new EventEmitter(); const ticks: MarketTickEvent[] = []; bus.on('market.tick', (event) => ticks.push(event));
  const receiveMs = Date.UTC(2026, 7, 20, 3, 45, 0);
  const processor = new TickProcessor(bus, () => receiveMs);
  processor.process(fullFeedWithTs(String(receiveMs + 60_000)), 7);
  assert.equal(ticks.length, 0);
});

test('B1-3: a source timestamp exactly equal to the receive reference is accepted', () => {
  const bus = new EventEmitter(); const ticks: MarketTickEvent[] = []; bus.on('market.tick', (event) => ticks.push(event));
  const receiveMs = Date.UTC(2026, 7, 20, 3, 45, 0);
  const processor = new TickProcessor(bus, () => receiveMs);
  processor.process(fullFeedWithTs(String(receiveMs)), 7);
  assert.equal(ticks.length, 1);
  assert.equal(ticks[0].timestamp, new Date(receiveMs).toISOString());
});

test('B1-4: a legitimate past source timestamp remains accepted at the live canonical boundary', () => {
  const bus = new EventEmitter(); const ticks: MarketTickEvent[] = []; bus.on('market.tick', (event) => ticks.push(event));
  const receiveMs = Date.UTC(2026, 7, 20, 3, 45, 0);
  const processor = new TickProcessor(bus, () => receiveMs);
  processor.process(fullFeedWithTs(String(receiveMs - 60_000)), 7);
  assert.equal(ticks.length, 1);
});

test('B1-9: advancing local/reference time does not resurrect a rejected future timestamp as fresh -- it is only ever accepted once genuinely in the past, as an ordinary (non-fresh) past event', () => {
  const bus = new EventEmitter(); const ticks: MarketTickEvent[] = [];
  bus.on('market.tick', (event) => ticks.push(event));
  let receiveMs = Date.UTC(2026, 7, 20, 3, 45, 0);
  const poisonedFutureTs = receiveMs + 5_000;
  const processor = new TickProcessor(bus, () => receiveMs);
  processor.process(fullFeedWithTs(String(poisonedFutureTs)), 7);
  assert.equal(ticks.length, 0, 'rejected while still future');
  receiveMs += 2_000; // reference advances, poisoned timestamp is still ahead of it
  processor.process(fullFeedWithTs(String(poisonedFutureTs)), 7);
  assert.equal(ticks.length, 0, 'still rejected -- the same timestamp never becomes fresh just because local time advanced');
  receiveMs = poisonedFutureTs + 1; // reference finally, genuinely passes the timestamp
  processor.process(fullFeedWithTs(String(poisonedFutureTs)), 7);
  assert.equal(ticks.length, 1, 'now genuinely in the past relative to the reference, so it is an ordinary accepted event -- not a special "resurrected fresh" one');
});
