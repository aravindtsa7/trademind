process.env.SHADOW_ONLY = 'true';
process.env.PAPER_TRADING_ONLY = 'true';
process.env.PAPER_STRATEGY_ID = 'V4_NIFTY_MOMENTUM_PE_SHADOW';
if (!process.env.TRADING_LOG_MODE?.trim()) process.env.TRADING_LOG_MODE = 'TRADING';
void import('./test-live-v4-nifty-momentum-shadow');
