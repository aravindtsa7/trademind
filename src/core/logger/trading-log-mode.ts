export type TradingLogMode = 'TRADING' | 'DEBUG';
export type TradingLogCategory =
  | 'RAW_MARKET_DATA_PACKET'
  | 'CONNECTION'
  | 'SUBSCRIPTION'
  | 'COMPLETED_CANDLE'
  | 'V2_EVALUATION'
  | 'V2_ENTRY_EXIT'
  | 'V4_EVALUATION'
  | 'V4_ENTRY_EXIT'
  | 'RUNTIME_STATUS'
  | 'WARNING'
  | 'ERROR';

type LogEnvironment = { TRADING_LOG_MODE?: string };

/**
 * Runtime entry points opt into TRADING explicitly. Other development commands
 * retain DEBUG packet visibility unless they set the mode themselves.
 */
export function resolveTradingLogMode(environment: LogEnvironment = process.env): TradingLogMode {
  return environment.TRADING_LOG_MODE?.trim().toUpperCase() === 'TRADING' ? 'TRADING' : 'DEBUG';
}

/** Warnings/errors and strategy/runtime events must remain visible in every mode. */
export function shouldEmitTradingLog(category: TradingLogCategory, environment: LogEnvironment = process.env): boolean {
  if (category === 'RAW_MARKET_DATA_PACKET') return resolveTradingLogMode(environment) === 'DEBUG';
  return true;
}
