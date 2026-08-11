import assert from 'node:assert/strict';
import test from 'node:test';
import { AdaptivePrimaryMarketRegime } from '../types/adaptive-market-regime.types';
import V2TrendDownEntryEvaluatorService from './v2-trend-down-entry-evaluator.service';
import { matchesTrendDirectionalEma35Pullback } from '../../../tests/helpers/trend-directional-ema35-pullback';

const at = (minute: number) => new Date(`2026-07-15T09:${String(minute).padStart(2, '0')}:00+05:30`);
test('matches frozen research boolean and ten-minute entry-timestamp cooldown exactly', () => {
  const evaluator = new V2TrendDownEntryEvaluatorService(); const rows = [
    { timestamp: at(20), close: 99, high: 100.1, ema35: 100, rsi14: 34, regime: AdaptivePrimaryMarketRegime.TREND_DOWN },
    { timestamp: at(25), close: 99, high: 100.1, ema35: 100, rsi14: 34, regime: AdaptivePrimaryMarketRegime.TREND_DOWN },
    { timestamp: at(30), close: 99, high: 100.1, ema35: 100, rsi14: 34, regime: AdaptivePrimaryMarketRegime.TREND_DOWN },
    { timestamp: at(35), close: 99, high: 100.3, ema35: 100, rsi14: 34, regime: AdaptivePrimaryMarketRegime.TREND_DOWN },
  ];
  const research = rows.filter((row) => matchesTrendDirectionalEma35Pullback({ direction: 'DOWN', close: row.close, high: row.high, low: 98, ema35: row.ema35, rsi: row.rsi14, proximity: 0.20, rsiFilter: 'RSI_LT_35' })).map((row) => row.timestamp.getTime());
  const runtime = rows.filter((row) => evaluator.evaluate({ completedCandleTimestamp: row.timestamp, regime: row.regime, close: row.close, high: row.high, ema35: row.ema35, rsi14: row.rsi14 }).entry).map((row) => row.timestamp.getTime());
  assert.deepEqual(runtime, [research[0], research[2]]); assert.equal(evaluator.evaluate({ completedCandleTimestamp: at(40), regime: AdaptivePrimaryMarketRegime.TREND_UP, close: 99, high: 100.1, ema35: 100, rsi14: 34 }).reason, 'BLOCKED_NOT_TREND_DOWN'); assert.equal(evaluator.evaluate({ completedCandleTimestamp: at(45), regime: undefined, close: undefined, high: undefined, ema35: undefined, rsi14: undefined }).reason, 'BLOCKED_NOT_READY');
});
