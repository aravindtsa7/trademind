import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'events';
import TickProcessor, { MarketDepthEvent, MarketGreeksEvent, MarketTickEvent } from './tick.processor';
import logger from '../../../core/logger/logger';

/** Captures logger.warn(...) calls for the duration of `run`, then restores the original. */
function captureWarnLogs(run: () => void): Array<{ message: string; meta: unknown }> {
  const calls: Array<{ message: string; meta: unknown }> = [];
  const original = logger.warn;
  logger.warn = ((message: string, meta?: unknown) => { calls.push({ message, meta }); return logger; }) as typeof logger.warn;
  try {
    run();
  } finally {
    logger.warn = original;
  }
  return calls;
}

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

// A7-H1 Part 4: bounded structured diagnostics for a rejected future/invalid source
// timestamp, so the real provider forward-skew can be measured from logs before any
// tolerance is ever raised above DEFAULT_PROVIDER_FORWARD_SKEW_TOLERANCE_MS. As of the
// A7-H1 clock-uncertainty correction, the default tolerance is 150ms (an evidence-based
// host-clock-uncertainty allowance, not an Upstox SLA) -- these diagnostics therefore use
// a multi-second offset (matching the earlier ~3.3s genuinely-unhealthy-clock episode) so
// the packet is still genuinely rejected under the new bound; the boundary itself
// (0/small-positive/150/151/multi-second) is covered precisely in
// market-data-timestamp.test.ts.

test('A7-H1: a rejected future source timestamp logs bounded structured diagnostics -- forwardSkewMs, allowedForwardSkewMs, generationId, instrumentKeys, and the interpreted field name', () => {
  const bus = new EventEmitter();
  const receiveMs = Date.UTC(2026, 7, 20, 3, 45, 0);
  const processor = new TickProcessor(bus, () => receiveMs);
  const warnCalls = captureWarnLogs(() => {
    processor.process(fullFeedWithTs(String(receiveMs + 3_300)), 7); // +3.3s, matching the earlier genuinely-unhealthy-clock episode -- well beyond the 150ms bound
  });
  assert.equal(warnCalls.length, 1);
  assert.equal(warnCalls[0].message, 'Ignoring market data message with invalid or future source timestamp');
  const meta = warnCalls[0].meta as Record<string, unknown>;
  assert.equal(meta.sourceTsField, 'currentTs');
  assert.equal(meta.sourceTimestampRaw, String(receiveMs + 3_300));
  assert.equal(meta.sourceTimestamp, new Date(receiveMs + 3_300).toISOString());
  assert.equal(meta.referenceTimestamp, new Date(receiveMs).toISOString());
  assert.equal(meta.forwardSkewMs, 3_300);
  assert.equal(meta.allowedForwardSkewMs, 150);
  assert.equal(meta.generationId, 7);
  assert.deepEqual(meta.instrumentKeys, ['NSE_FO|45102']);
});

test('A7-H1: the rejected-source-timestamp diagnostic never includes the access token or the raw feed payload -- only identifiers already public in every other market-data log line', () => {
  const bus = new EventEmitter();
  const receiveMs = Date.UTC(2026, 7, 20, 3, 45, 0);
  const processor = new TickProcessor(bus, () => receiveMs);
  const warnCalls = captureWarnLogs(() => {
    processor.process(fullFeedWithTs(String(receiveMs + 3_300)), 7);
  });
  const meta = warnCalls[0].meta as Record<string, unknown>;
  const serialized = JSON.stringify(meta);
  assert.ok(!('feeds' in meta), 'must never include the raw per-instrument feed payload');
  assert.ok(!/access.?token|bearer/i.test(serialized), 'must never include an access token or bearer credential');
});

test('A7-H1: a genuinely invalid (non-numeric, non-ISO) source timestamp still logs diagnostics with forwardSkewMs omitted, since no source instant could be interpreted', () => {
  const bus = new EventEmitter();
  const receiveMs = Date.UTC(2026, 7, 20, 3, 45, 0);
  const processor = new TickProcessor(bus, () => receiveMs);
  const warnCalls = captureWarnLogs(() => {
    processor.process(fullFeedWithTs('not-a-timestamp'), 7);
  });
  assert.equal(warnCalls.length, 1);
  const meta = warnCalls[0].meta as Record<string, unknown>;
  assert.equal(meta.sourceTimestamp, undefined);
  assert.equal(meta.forwardSkewMs, undefined);
  assert.equal(meta.sourceTimestampRaw, 'not-a-timestamp');
});

test('A7-H1: a small positive skew within the new 150ms bound is accepted and never reaches the rejection diagnostic', () => {
  const bus = new EventEmitter();
  const ticks: MarketTickEvent[] = [];
  bus.on('market.tick', (event) => ticks.push(event));
  const receiveMs = Date.UTC(2026, 7, 20, 3, 45, 0);
  const processor = new TickProcessor(bus, () => receiveMs);
  const warnCalls = captureWarnLogs(() => {
    processor.process(fullFeedWithTs(String(receiveMs + 90)), 7); // matches the reported live NTP-adjacent skew (85-92ms)
  });
  assert.equal(warnCalls.length, 0, 'a skew within the evidence-based 150ms bound must not be logged as rejected');
  assert.equal(ticks.length, 1, 'the tick is accepted, not dropped');
});

test('A7-H1: the rejected-source-timestamp diagnostic is rate-limited so a sustained clock-skew episode cannot flood the log once per tick, while every packet is still dropped', () => {
  const bus = new EventEmitter();
  const ticks: MarketTickEvent[] = [];
  bus.on('market.tick', (event) => ticks.push(event));
  let receiveMs = Date.UTC(2026, 7, 20, 3, 45, 0);
  const processor = new TickProcessor(bus, () => receiveMs, 5_000);
  const warnCalls = captureWarnLogs(() => {
    processor.process(fullFeedWithTs(String(receiveMs + 3_300)), 7);
    receiveMs += 1_000; // still well within the 5s rate-limit window
    processor.process(fullFeedWithTs(String(receiveMs + 3_300)), 7);
    receiveMs += 1_000;
    processor.process(fullFeedWithTs(String(receiveMs + 3_300)), 7);
  });
  assert.equal(ticks.length, 0, 'every rejected packet is still dropped regardless of logging');
  assert.equal(warnCalls.length, 1, 'only the first occurrence within the rate-limit window is logged');

  const moreWarnCalls = captureWarnLogs(() => {
    receiveMs += 10_000; // now well past the 5s window
    processor.process(fullFeedWithTs(String(receiveMs + 3_300)), 7);
  });
  assert.equal(moreWarnCalls.length, 1, 'logging resumes once the rate-limit window has elapsed');
});

// A7-H2 Blocker 2: the rejected-timestamp diagnostic must be unconditionally nonthrowing.
// currentTs="9007199254740991" (Number.MAX_SAFE_INTEGER) is a safe integer but far outside
// the ECMA-262 valid Date range (+-8,640,000,000,000,000ms from the epoch); the diagnostic
// path previously called `new Date(sourceTimestampMs).toISOString()` on it unvalidated,
// throwing RangeError: Invalid time value and crashing the packet-receive path.

test('A7-H2: an extreme numeric currentTs (Number.MAX_SAFE_INTEGER) beyond the valid ECMAScript Date range is dropped from diagnostics without throwing', () => {
  const bus = new EventEmitter(); const ticks: MarketTickEvent[] = []; bus.on('market.tick', (event) => ticks.push(event));
  const receiveMs = Date.UTC(2026, 7, 20, 3, 45, 0);
  const processor = new TickProcessor(bus, () => receiveMs);
  let warnCalls: Array<{ message: string; meta: unknown }> = [];
  assert.doesNotThrow(() => {
    warnCalls = captureWarnLogs(() => processor.process(fullFeedWithTs('9007199254740991'), 7));
  });
  assert.equal(ticks.length, 0, 'the packet is still rejected/dropped');
  assert.equal(warnCalls.length, 1);
  const meta = warnCalls[0].meta as Record<string, unknown>;
  assert.equal(meta.sourceTimestampRaw, '9007199254740991');
  assert.equal(meta.sourceTimestamp, undefined, 'an unrepresentable Date must be dropped, never fed to toISOString()');
  assert.equal(meta.forwardSkewMs, undefined);
});

test('A7-H2: an extreme negative numeric currentTs beyond the valid ECMAScript Date range is also dropped from diagnostics without throwing', () => {
  const bus = new EventEmitter();
  const receiveMs = Date.UTC(2026, 7, 20, 3, 45, 0);
  const processor = new TickProcessor(bus, () => receiveMs);
  let warnCalls: Array<{ message: string; meta: unknown }> = [];
  assert.doesNotThrow(() => {
    warnCalls = captureWarnLogs(() => processor.process(fullFeedWithTs('-9007199254740991'), 7));
  });
  assert.equal(warnCalls.length, 1);
  const meta = warnCalls[0].meta as Record<string, unknown>;
  assert.equal(meta.sourceTimestamp, undefined);
});

test('A7-H2: a seconds-form (10-digit) currentTs is a stale/rejected epoch-milliseconds interpretation but never throws while diagnosing it', () => {
  const bus = new EventEmitter();
  const receiveMs = Date.UTC(2026, 7, 20, 3, 45, 0);
  const processor = new TickProcessor(bus, () => receiveMs);
  let warnCalls: Array<{ message: string; meta: unknown }> = [];
  assert.doesNotThrow(() => {
    warnCalls = captureWarnLogs(() => processor.process(fullFeedWithTs('1723618200'), 7)); // seconds, not ms -- interpreted as an ancient ms instant
  });
  assert.equal(warnCalls.length, 1);
  const meta = warnCalls[0].meta as Record<string, unknown>;
  assert.equal(meta.sourceTimestampRaw, '1723618200');
  assert.equal(meta.sourceTimestamp, new Date(1_723_618_200).toISOString());
});

test('A7-H2: a microseconds-form (16-digit) currentTs never throws while diagnosing it', () => {
  const bus = new EventEmitter();
  const receiveMs = Date.UTC(2026, 7, 20, 3, 45, 0);
  const processor = new TickProcessor(bus, () => receiveMs);
  let warnCalls: Array<{ message: string; meta: unknown }> = [];
  assert.doesNotThrow(() => {
    warnCalls = captureWarnLogs(() => processor.process(fullFeedWithTs('1723618200000000'), 7)); // microseconds, not ms
  });
  assert.equal(warnCalls.length, 1);
  const meta = warnCalls[0].meta as Record<string, unknown>;
  assert.equal(meta.sourceTimestamp, new Date(1_723_618_200_000_000).toISOString(), 'a large-but-still-ECMA-valid instant is diagnosed normally, not dropped');
});

test('A7-H2: a malformed (non-numeric, non-parsable) currentTs never throws while diagnosing it', () => {
  const bus = new EventEmitter();
  const receiveMs = Date.UTC(2026, 7, 20, 3, 45, 0);
  const processor = new TickProcessor(bus, () => receiveMs);
  let warnCalls: Array<{ message: string; meta: unknown }> = [];
  assert.doesNotThrow(() => {
    warnCalls = captureWarnLogs(() => processor.process(fullFeedWithTs('garbage-not-a-timestamp'), 7));
  });
  assert.equal(warnCalls.length, 1);
  const meta = warnCalls[0].meta as Record<string, unknown>;
  assert.equal(meta.sourceTimestamp, undefined);
});

test('A7-H2: an ordinary rejected future timestamp still provides structured skew diagnostics (unchanged by the RangeError fix)', () => {
  const bus = new EventEmitter();
  const receiveMs = Date.UTC(2026, 7, 20, 3, 45, 0);
  const processor = new TickProcessor(bus, () => receiveMs);
  const warnCalls = captureWarnLogs(() => processor.process(fullFeedWithTs(String(receiveMs + 5_000)), 7));
  assert.equal(warnCalls.length, 1);
  const meta = warnCalls[0].meta as Record<string, unknown>;
  assert.equal(meta.sourceTimestamp, new Date(receiveMs + 5_000).toISOString());
  assert.equal(meta.forwardSkewMs, 5_000);
});
