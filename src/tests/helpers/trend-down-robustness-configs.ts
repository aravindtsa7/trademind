export interface TrendDownRobustnessConfig {
  timeframe: 3 | 5;
  proximity: 0.15 | 0.20 | 0.25;
  rsiFilter: 'RSI_LT_35';
  cooldown: 0 | 5 | 10;
}

export const trendDownRobustnessConfigs: readonly TrendDownRobustnessConfig[] = [
  { timeframe: 5, proximity: 0.20, rsiFilter: 'RSI_LT_35', cooldown: 0 },
  { timeframe: 5, proximity: 0.20, rsiFilter: 'RSI_LT_35', cooldown: 5 },
  { timeframe: 5, proximity: 0.20, rsiFilter: 'RSI_LT_35', cooldown: 10 },
  { timeframe: 5, proximity: 0.25, rsiFilter: 'RSI_LT_35', cooldown: 0 },
  { timeframe: 5, proximity: 0.25, rsiFilter: 'RSI_LT_35', cooldown: 10 },
  { timeframe: 3, proximity: 0.15, rsiFilter: 'RSI_LT_35', cooldown: 0 },
  { timeframe: 3, proximity: 0.15, rsiFilter: 'RSI_LT_35', cooldown: 10 },
];
