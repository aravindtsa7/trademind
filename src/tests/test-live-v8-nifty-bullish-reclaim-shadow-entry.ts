process.env.SHADOW_ONLY = 'true';
process.env.PAPER_TRADING_ONLY = 'true';
process.env.PAPER_STRATEGY_ID = 'V8_NIFTY_BULLISH_RECLAIM_CE_SHADOW';
if (!process.env.TRADING_LOG_MODE?.trim()) process.env.TRADING_LOG_MODE = 'TRADING';
void import('./test-live-v8-nifty-bullish-reclaim-shadow').then(({ run }) => run()).catch((error) => {
  console.error('[V8_SHADOW_FATAL]', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
