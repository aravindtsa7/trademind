import { EventEmitter } from 'events';
import { LivePaperCompletedCandleInput, LivePaperStrategyResult } from './live-paper-strategy.dto';
import { PaperOrder } from '../types/paper-trading.types';

export enum PaperTradingRuntimeState {
  STOPPED = 'STOPPED',
  STARTING = 'STARTING',
  RUNNING = 'RUNNING',
  STOPPING = 'STOPPING',
}

export interface PaperTradingRuntimeStatus {
  state: PaperTradingRuntimeState;
  startedAt: Date | null;
  stoppedAt: Date | null;
  completedCandlesProcessed: number;
  noTradeEvaluations: number;
  filteredSignals: number;
  paperOrdersCreated: number;
  targetExits: number;
  stopExits: number;
  timeExits: number;
  activeOrderCount: number;
}

export interface PaperTradingRuntimeStopResult {
  status: PaperTradingRuntimeStatus;
  openOrdersRemaining: number;
}

export interface PaperTradingRuntimeStrategyAdapter {
  processCompletedCandle(input: LivePaperCompletedCandleInput): Promise<LivePaperStrategyResult>;
}

export interface PaperTradingRuntimeMarketDataAdapter {
  start(): void;
  stop(): void;
}

export interface PaperTradingRuntimeOrderManager {
  getActiveOrders(): PaperOrder[];
}

export type PaperTradingRuntimeEventBus = EventEmitter;
