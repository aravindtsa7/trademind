import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adaptV9OptionCandles } from '../modules/research/v9-nifty-volatility-expansion/v9-option-candle-adapter';

const row = (timestamp: Date, close = 100) => ({ instrumentKey: 'OPT', timestamp, open: 99, high: 101, low: 98, close, volume: 10, openInterest: 20 });
test('maps timestamp to candleTime with full DTO fields and chronological ordering', () => { const source = [row(new Date('2026-03-02T04:01:00Z')), row(new Date('2026-03-02T04:00:00Z'))]; const adapted = adaptV9OptionCandles(source); assert.equal(adapted[0].candleTime.toISOString(), '2026-03-02T04:00:00.000Z'); assert.equal(adapted[0].volume, 10n); assert.equal(adapted[0].openInterest, 20n); assert.equal(source[0].timestamp.toISOString(), '2026-03-02T04:01:00.000Z'); });
test('rejects malformed OHLC and duplicate timestamps', () => { assert.throws(() => adaptV9OptionCandles([{ ...row(new Date()), close: 'bad' }])); const t = new Date('2026-03-02T04:00:00Z'); assert.throws(() => adaptV9OptionCandles([row(t), row(new Date(t.getTime()))])); });
