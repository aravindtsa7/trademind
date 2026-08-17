import { MarketDataSubscription, MarketDataSubscriptionMode } from '../../market-data/managers/subscription.manager';
import { OptionContract, OptionContractSelectionResult } from '../../options/types';
import { StrategySignal } from '../../strategies/dto/strategy-signal.dto';
import { PaperOrder } from '../types/paper-trading.types';
import { ExecutionQuoteSnapshot } from './paper-fill-model.dto';

export interface PaperTradingSignalInput {
  signalTimestamp: Date;
  signalType: StrategySignal;
  underlying: string;
  spotPrice: number;
}

export interface PaperTradingExitPolicyInput {
  targetPercent: number;
  stopLossPercent: number;
  maximumHoldingMinutes: number;
}

export interface PaperEntryPremiumProvider {
  getObservedPremium(instrumentKey: string): Promise<number | PaperEntryQuoteObservation>;
}

/** A captured entry observation; execution uses this exact quote when supplied. */
export interface PaperEntryQuoteObservation {
  observedEntryPremium: number;
  executionQuote?: ExecutionQuoteSnapshot;
}

export interface PaperExecutionQuoteProvider {
  getExecutionQuoteSnapshot(instrumentKey: string): ExecutionQuoteSnapshot | undefined;
  waitForExecutionQuote?(instrumentKey: string, eligibleAt: Date, timeoutMs: number): Promise<ExecutionQuoteSnapshot | undefined>;
}

/** Structural boundary satisfied by the existing SubscriptionManager. */
export interface PaperMarketDataSubscriptionGateway {
  subscribe(instrumentKey: string, mode?: MarketDataSubscriptionMode): Promise<void>;
  getSubscriptions(): MarketDataSubscription[];
}

export interface PaperTradingOrchestrationRequest {
  signal: PaperTradingSignalInput;
  contracts: readonly OptionContract[];
  exitPolicy: PaperTradingExitPolicyInput;
  /** Optional direct premium; otherwise the injected provider is used. */
  observedEntryPremium?: number;
}

export interface PaperTradingSubscriptionResult {
  instrumentKey: string;
  requested: boolean;
}

export interface PaperTradingOrchestrationResult {
  order: PaperOrder;
  selectedContract: OptionContract;
  selection: OptionContractSelectionResult;
  subscription: PaperTradingSubscriptionResult;
  observedEntryPremium: number;
}
