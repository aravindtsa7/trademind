export enum StrategySignal {
  BUY_CE = 'BUY_CE',
  BUY_PE = 'BUY_PE',
  NO_TRADE = 'NO_TRADE',
}

export interface StrategySignalDto {
  signal: StrategySignal;
  confidence: number;
  reasons: string[];
  entryPrice?: number;
  stopLoss?: number;
  targets?: number[];
}
