import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'events';
import { LiveCandleDto } from '../dto/live-candle.dto';
import LiveCandleBuilderService from './live-candle-builder.service';
import LiveCandleEventAdapterService from './live-candle-event-adapter.service';
import TickProcessor from '../processors/tick.processor';

function ist(hour: number, minute: number, second = 0): Date { return new Date(Date.UTC(2026, 7, 10, hour, minute, second) - (5 * 60 + 30) * 60_000); }
function tick(instrumentKey: string, hour: number, minute: number, ltp: number, second = 0) { return { instrumentKey, timestamp: ist(hour, minute, second).toISOString(), ltp }; }
function setup() { const bus = new EventEmitter(); const builder = new LiveCandleBuilderService(); const adapter = new LiveCandleEventAdapterService(builder, bus); return { bus, builder, adapter }; }

test('start registers one market.tick listener', () => {
  const { bus, adapter } = setup(); adapter.start(); assert.equal(bus.listenerCount('market.tick'), 1);
});

test('duplicate start is safe', () => {
  const { bus, adapter } = setup(); adapter.start(); adapter.start(); assert.equal(bus.listenerCount('market.tick'), 1);
});

test('stop removes the market.tick listener', () => {
  const { bus, adapter } = setup(); adapter.start(); adapter.stop(); assert.equal(bus.listenerCount('market.tick'), 0);
});

test('duplicate stop is safe', () => {
  const { bus, adapter } = setup(); adapter.stop(); adapter.stop(); assert.equal(bus.listenerCount('market.tick'), 0);
});

test('forwards valid tick to all shared candle-builder timeframes', () => {
  const { bus, builder, adapter } = setup(); adapter.start(); bus.emit('market.tick', tick('NIFTY', 9, 15, 100));
  assert.equal(builder.getActiveCandle('NIFTY', '1m')?.close, 100); assert.equal(builder.getActiveCandle('NIFTY', '2m')?.close, 100); assert.equal(builder.getActiveCandle('NIFTY', '5m')?.close, 100);
});

test('emits completed 1m candle', () => {
  const { bus, adapter } = setup(); const events: LiveCandleDto[] = []; bus.on('market.candle.completed', (event) => events.push(event)); adapter.start(); bus.emit('market.tick', tick('NIFTY', 9, 15, 100)); bus.emit('market.tick', tick('NIFTY', 9, 16, 101));
  const oneMinute = events.find((event) => event.timeframe === '1m'); assert.equal(oneMinute?.completed, true); assert.equal(oneMinute?.open, 100);
});

test('emits completed 5m candle', () => {
  const { bus, adapter } = setup(); const events: LiveCandleDto[] = []; bus.on('market.candle.completed', (event) => events.push(event)); adapter.start(); bus.emit('market.tick', tick('NIFTY', 9, 15, 100)); bus.emit('market.tick', tick('NIFTY', 9, 20, 101));
  const fiveMinute = events.find((event) => event.timeframe === '5m'); assert.equal(fiveMinute?.completed, true); assert.equal(fiveMinute?.candleTime.getTime(), ist(9, 15).getTime());
});

test('does not emit incomplete active candle', () => {
  const { bus, adapter } = setup(); const events: LiveCandleDto[] = []; bus.on('market.candle.completed', (event) => events.push(event)); adapter.start(); bus.emit('market.tick', tick('NIFTY', 9, 15, 100));
  assert.equal(events.length, 0);
});

test('ignores malformed ticks', () => {
  const { bus, builder, adapter } = setup(); adapter.start(); bus.emit('market.tick', {}); bus.emit('market.tick', { instrumentKey: 'NIFTY', timestamp: 'invalid', ltp: 100 }); bus.emit('market.tick', { instrumentKey: 'NIFTY', timestamp: ist(9, 15).toISOString(), ltp: 0 });
  assert.equal(builder.getActiveCandle('NIFTY', '1m'), undefined);
});

test('does not emit duplicate completed candles', () => {
  const { bus, adapter } = setup(); const events: LiveCandleDto[] = []; bus.on('market.candle.completed', (event) => events.push(event)); adapter.start(); bus.emit('market.tick', tick('NIFTY', 9, 15, 100)); bus.emit('market.tick', tick('NIFTY', 9, 16, 101)); bus.emit('market.tick', tick('NIFTY', 9, 16, 102));
  assert.equal(events.filter((event) => event.timeframe === '1m').length, 1);
});

test('stopped adapter ignores ticks', () => {
  const { bus, builder, adapter } = setup(); adapter.start(); adapter.stop(); bus.emit('market.tick', tick('NIFTY', 9, 15, 100));
  assert.equal(builder.getActiveCandle('NIFTY', '1m'), undefined);
});

test('does not mutate incoming tick events', () => {
  const { bus, adapter } = setup(); const event = tick('NIFTY', 9, 15, 100); const original = structuredClone(event); adapter.start(); bus.emit('market.tick', event);
  assert.deepEqual(event, original);
});

test('production-shaped epoch source timestamps pass through TickProcessor and complete candles', () => {
  const { bus, adapter } = setup(); const events: LiveCandleDto[] = []; const processor = new TickProcessor(bus); adapter.start(); bus.on('market.candle.completed', (event) => events.push(event));
  processor.process({ type:'live_feed', currentTs:String(ist(9, 15).getTime()), feeds:{ NIFTY:{ ltpc:{ ltp:100 } } } }, 3);
  processor.process({ type:'live_feed', currentTs:String(ist(9, 16).getTime()), feeds:{ NIFTY:{ ltpc:{ ltp:101 } } } }, 3);
  assert.equal(events.filter((event) => event.timeframe === '1m').length, 1);
});

test('EOD flushes the final observed in-session candle once and repeated post-market ticks create no candle', () => {
  const { bus, builder, adapter } = setup(); const events: LiveCandleDto[] = []; bus.on('market.candle.completed', (event) => events.push(event)); adapter.start();
  bus.emit('market.tick', tick('NIFTY', 15, 25, 100)); bus.emit('market.tick', tick('NIFTY', 15, 29, 101)); adapter.finishSession('NIFTY'); adapter.finishSession('NIFTY');
  bus.emit('market.tick', tick('NIFTY', 15, 30, 102)); bus.emit('market.tick', tick('NIFTY', 15, 31, 103));
  assert.equal(events.filter((event) => event.timeframe === '5m' && event.candleTime.getTime() === ist(15, 25).getTime()).length, 1);
  assert.equal(builder.getActiveCandle('NIFTY', '5m'), undefined);
});
