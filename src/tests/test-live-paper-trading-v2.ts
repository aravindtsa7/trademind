/**
 * Separate PAPER-ONLY V2 process. It must never be loaded by the V1 command.
 * The imported harness constructs fresh runtime/order/position state in this process.
 */
process.env.TRADING_STRATEGY_VERSION = 'V2';
process.env.PAPER_STRATEGY_ID = 'V2_TREND_DOWN_PE';
process.env.PAPER_TRADING_ONLY = 'true';
if (!process.env.TRADING_LOG_MODE?.trim()) process.env.TRADING_LOG_MODE = 'TRADING';
console.log('[V2_STARTUP] strategyId=V2_TREND_DOWN_PE paperOnly=true logMode=' + process.env.TRADING_LOG_MODE + ' target=' + (process.env.V2_TARGET_PERCENT ?? '5') + ' stop=' + (process.env.V2_STOP_PERCENT ?? '5') + ' hold=' + (process.env.V2_MAX_HOLD_MINUTES ?? '15'));
void import('./test-live-paper-trading');
