import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveTradingLogMode, shouldEmitTradingLog, TradingLogCategory } from './trading-log-mode';

const visibleInTrading: readonly TradingLogCategory[] = [
  'CONNECTION', 'SUBSCRIPTION', 'COMPLETED_CANDLE', 'V2_EVALUATION',
  'V2_ENTRY_EXIT', 'V4_EVALUATION', 'V4_ENTRY_EXIT', 'RUNTIME_STATUS', 'WARNING', 'ERROR',
];

test('TRADING mode hides raw market-data packet diagnostics but preserves trading, connection, warning, and error logs', () => {
  const environment = { TRADING_LOG_MODE: 'TRADING' };
  assert.equal(resolveTradingLogMode(environment), 'TRADING');
  assert.equal(shouldEmitTradingLog('RAW_MARKET_DATA_PACKET', environment), false);
  visibleInTrading.forEach((category) => assert.equal(shouldEmitTradingLog(category, environment), true, category));
});

test('DEBUG mode restores raw market-data packet diagnostics', () => {
  const environment = { TRADING_LOG_MODE: 'DEBUG' };
  assert.equal(resolveTradingLogMode(environment), 'DEBUG');
  assert.equal(shouldEmitTradingLog('RAW_MARKET_DATA_PACKET', environment), true);
});
