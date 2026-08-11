import assert from 'node:assert/strict';
import test from 'node:test';
import { trendDownRobustnessConfigs } from './helpers/trend-down-robustness-configs';

test('robustness study is restricted to the seven requested TREND_DOWN configurations', () => {
  assert.deepEqual(trendDownRobustnessConfigs, [
    { timeframe: 5, proximity: 0.20, rsiFilter: 'RSI_LT_35', cooldown: 0 },
    { timeframe: 5, proximity: 0.20, rsiFilter: 'RSI_LT_35', cooldown: 5 },
    { timeframe: 5, proximity: 0.20, rsiFilter: 'RSI_LT_35', cooldown: 10 },
    { timeframe: 5, proximity: 0.25, rsiFilter: 'RSI_LT_35', cooldown: 0 },
    { timeframe: 5, proximity: 0.25, rsiFilter: 'RSI_LT_35', cooldown: 10 },
    { timeframe: 3, proximity: 0.15, rsiFilter: 'RSI_LT_35', cooldown: 0 },
    { timeframe: 3, proximity: 0.15, rsiFilter: 'RSI_LT_35', cooldown: 10 },
  ]);
});
