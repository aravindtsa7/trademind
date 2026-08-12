import assert from 'node:assert/strict';
import test from 'node:test';
import LiveCandleBuilderService from './live-candle-builder.service';

test('3m shadow evaluations are emitted only when a complete 3m candle rolls over', () => {
  const builder = new LiveCandleBuilderService(); const at = (minute: number) => new Date(`2026-08-12T09:${String(minute).padStart(2,'0')}:00+05:30`);
  assert.equal(builder.processTick({ instrumentKey:'NSE_INDEX|Nifty 50', timestamp:at(15), ltp:100 },'3m').completedCandle, undefined);
  assert.equal(builder.processTick({ instrumentKey:'NSE_INDEX|Nifty 50', timestamp:at(16), ltp:101 },'3m').completedCandle, undefined);
  assert.equal(builder.processTick({ instrumentKey:'NSE_INDEX|Nifty 50', timestamp:at(17), ltp:102 },'3m').completedCandle, undefined);
  const completed=builder.processTick({ instrumentKey:'NSE_INDEX|Nifty 50', timestamp:at(18), ltp:103 },'3m').completedCandle;
  assert.ok(completed); assert.equal(completed?.candleTime.toISOString(),'2026-08-12T03:45:00.000Z'); assert.equal(completed?.close,102);
});
