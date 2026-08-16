import { MarketDataSubscriptionMode } from '../../market-data/managers/subscription.manager';
import OptionContractSelectorService from '../../options/services/option-contract-selector.service';
import { OptionContract, OptionContractSelectionResult } from '../../options/types';
import { StrategySignal } from '../../strategies/dto/strategy-signal.dto';
import {
  PaperEntryPremiumProvider,
  PaperExecutionQuoteProvider,
  PaperMarketDataSubscriptionGateway,
  PaperTradingOrchestrationRequest,
  PaperTradingOrchestrationResult,
} from '../dto/paper-trading-orchestrator.dto';
import PaperOrderManagerService from './paper-order-manager.service';
import RuntimeRiskGateService, { RiskDeniedError, RuntimeRiskIntent } from '../../risk/runtime-risk-gate.service';
import logger from '../../../core/logger/logger';
import { PaperEntryQuoteWaitError } from './paper-entry-quote-waiter.service';
import PaperPortfolioService from './paper-portfolio.service';
import PaperFillModelService, { PaperFillUnavailableError } from './paper-fill-model.service';

interface OptionContractSelector {
  select(request: {
    underlying: string;
    spotPrice: number;
    signal: StrategySignal.BUY_CE | StrategySignal.BUY_PE;
    timestamp: Date;
    contracts: readonly OptionContract[];
  }): OptionContractSelectionResult;
}

export interface PaperTradeRiskContextProvider {
  buildIntent(input: { signal: PaperTradingOrchestrationRequest['signal']; contract: OptionContract; observedEntryPremium: number }): RuntimeRiskIntent;
}

/**
 * Coordinates an already-generated actionable signal into an OPEN paper order.
 * It deliberately owns neither signal generation nor market-data state.
 */
export default class PaperTradingOrchestratorService {
  constructor(
    private readonly contractSelector: OptionContractSelector = new OptionContractSelectorService(),
    private readonly orderManager: PaperOrderManagerService,
    private readonly subscriptionManager: PaperMarketDataSubscriptionGateway,
    private readonly premiumProvider: PaperEntryPremiumProvider,
    private readonly subscriptionMode: MarketDataSubscriptionMode = MarketDataSubscriptionMode.FULL,
    private readonly riskGate?: RuntimeRiskGateService,
    private readonly riskContextProvider?: PaperTradeRiskContextProvider,
    private readonly portfolio?: PaperPortfolioService,
    private readonly fillModel?: PaperFillModelService,
    private readonly executionQuoteProvider?: PaperExecutionQuoteProvider,
  ) {}

  async createFromSignal(request: PaperTradingOrchestrationRequest): Promise<PaperTradingOrchestrationResult> {
    this.validateRequest(request);
    const signal = request.signal;
    const selection = this.contractSelector.select({
      underlying: signal.underlying,
      spotPrice: signal.spotPrice,
      signal: signal.signalType as StrategySignal.BUY_CE | StrategySignal.BUY_PE,
      timestamp: signal.signalTimestamp,
      contracts: request.contracts,
    });
    const selectedContract = request.contracts.find((contract) => contract.instrumentKey === selection.instrumentKey);
    if (!selectedContract) throw new Error('Selected option contract could not be found in supplied contracts.');
    if (!Number.isInteger(selectedContract.lotSize) || (selectedContract.lotSize as number) <= 0) {
      throw new Error('Selected option contract requires a valid positive integer lotSize.');
    }

    const isSubscribed = this.subscriptionManager.getSubscriptions()
      .some((subscription) => subscription.instrumentKey === selectedContract.instrumentKey);
    if (!isSubscribed) await this.subscriptionManager.subscribe(selectedContract.instrumentKey, this.subscriptionMode);

    let observedEntryPremium: number;
    try { observedEntryPremium = request.observedEntryPremium ?? await this.premiumProvider.getObservedPremium(selectedContract.instrumentKey); }
    catch (error) {
      if (error instanceof PaperEntryQuoteWaitError && this.riskGate && this.riskContextProvider) {
        const context = this.riskContextProvider.buildIntent({ signal, contract: selectedContract, observedEntryPremium: Number.NaN });
        const { entryPremium: _entryPremium, quantity: _quantity, ...external } = context;
        const decision = this.riskGate.denyExternal(external, error.reason);
        logger.info('RISK_DECISION', decision); throw new RiskDeniedError(decision);
      }
      throw error;
    }
    if (!Number.isFinite(observedEntryPremium) || observedEntryPremium <= 0) {
      throw new Error('Observed entry premium must be positive and finite.');
    }
    let approvedDecision: ReturnType<RuntimeRiskGateService['evaluate']> | undefined;
    if (this.riskGate) {
      if (!this.riskContextProvider) throw new Error('Risk gate is configured without a risk context provider.');
      approvedDecision = this.riskGate.evaluate(this.riskContextProvider.buildIntent({ signal, contract: selectedContract, observedEntryPremium }));
      logger.info('RISK_DECISION', approvedDecision);
      if (approvedDecision.decision === 'DENIED') throw new RiskDeniedError(approvedDecision);
    }

    let executionFill;
    let filledQuantity = selectedContract.lotSize as number;
    let simulatedEntryPremium = observedEntryPremium;
    if (this.fillModel) {
      if (!this.executionQuoteProvider) throw new Error('Paper fill model is configured without an execution quote provider.');
      const eligibleAt = new Date(signal.signalTimestamp.getTime() + this.fillModel.executionLatencyMs);
      let quote = this.executionQuoteProvider.getExecutionQuoteSnapshot(selectedContract.instrumentKey);
      if (this.fillModel.executionLatencyMs > 0) quote = await this.executionQuoteProvider.waitForExecutionQuote?.(selectedContract.instrumentKey, eligibleAt, Number(process.env.PAPER_FILL_WAIT_MS ?? 2_000)) ?? quote;
      const fill = this.fillModel.fill({ side:'BUY', requestedQuantity:selectedContract.lotSize as number, quote, intentTimestamp:signal.signalTimestamp });
      executionFill = this.fillModel.toSummary(fill);
      if (!executionFill) { logger.warn('PAPER_FILL_UNAVAILABLE', { strategyId: approvedDecision?.strategyId, instrument: selectedContract.instrumentKey, status:fill.status, reason:fill.reason, fillQuality:fill.fillQuality }); throw new PaperFillUnavailableError(fill); }
      filledQuantity = executionFill.filledQuantity;
      simulatedEntryPremium = executionFill.averageFillPrice;
    }
    const pending = this.orderManager.create({
      signalTimestamp: signal.signalTimestamp,
      signalType: signal.signalType as StrategySignal.BUY_CE | StrategySignal.BUY_PE,
      contract: {
        instrumentKey: selectedContract.instrumentKey,
        tradingSymbol: selectedContract.tradingSymbol,
        optionType: selectedContract.optionType,
        strikePrice: selectedContract.strikePrice,
        expiry: selectedContract.expiry,
        lotSize: selectedContract.lotSize as number,
        quantity: filledQuantity,
      },
      entry: {
        entryTimestamp: signal.signalTimestamp,
        observedEntryPremium,
        simulatedEntryPremium,
        executionFill,
      },
      exitConfiguration: { ...request.exitPolicy },
    });
    const order = this.orderManager.markOpen(pending.id);
    if (this.portfolio) {
      const context = this.riskContextProvider?.buildIntent({ signal, contract: selectedContract, observedEntryPremium });
      if (!context) throw new Error('Paper portfolio is configured without a risk context provider.');
      this.portfolio.open({ order, strategyId: context.strategyId, underlying: context.underlying, correlationId: approvedDecision?.correlationId ?? context.correlationId ?? RuntimeRiskGateService.intentId(context), intentId: approvedDecision?.intentId ?? RuntimeRiskGateService.intentId(context), sessionDate: context.sessionDate });
    }
    if (approvedDecision) this.riskGate?.recordOpenedOrder(approvedDecision, order.id);

    return {
      order,
      selectedContract: cloneContract(selectedContract),
      selection: { ...selection, expiry: new Date(selection.expiry.getTime()) },
      subscription: { instrumentKey: selectedContract.instrumentKey, requested: !isSubscribed },
      observedEntryPremium,
    };
  }

  private validateRequest(request: PaperTradingOrchestrationRequest): void {
    if (!request || typeof request !== 'object') throw new Error('Paper-trading orchestration request is required.');
    const { signal, exitPolicy } = request;
    if (!signal || typeof signal !== 'object') throw new Error('Paper-trading signal is required.');
    if (signal.signalType !== StrategySignal.BUY_CE && signal.signalType !== StrategySignal.BUY_PE) throw new Error('Paper trading accepts only BUY_CE or BUY_PE signals.');
    if (!(signal.signalTimestamp instanceof Date) || Number.isNaN(signal.signalTimestamp.getTime())) throw new Error('signalTimestamp must be a valid Date.');
    if (typeof signal.underlying !== 'string' || signal.underlying.trim().length === 0) throw new Error('underlying is required.');
    if (!Number.isFinite(signal.spotPrice) || signal.spotPrice <= 0) throw new Error('spotPrice must be positive and finite.');
    if (!Array.isArray(request.contracts) || request.contracts.length === 0) throw new Error('At least one option contract is required.');
    if (!exitPolicy || typeof exitPolicy !== 'object') throw new Error('Exit policy is required.');
    if (!Number.isFinite(exitPolicy.targetPercent) || exitPolicy.targetPercent <= 0) throw new Error('targetPercent must be positive and finite.');
    if (!Number.isFinite(exitPolicy.stopLossPercent) || exitPolicy.stopLossPercent <= 0 || exitPolicy.stopLossPercent > 100) throw new Error('stopLossPercent must be positive, finite, and at most 100.');
    if (!Number.isInteger(exitPolicy.maximumHoldingMinutes) || exitPolicy.maximumHoldingMinutes <= 0) throw new Error('maximumHoldingMinutes must be a positive integer.');
    if (request.observedEntryPremium !== undefined && (!Number.isFinite(request.observedEntryPremium) || request.observedEntryPremium <= 0)) throw new Error('Observed entry premium must be positive and finite.');
  }
}

function cloneContract(contract: OptionContract): OptionContract {
  return { ...contract, expiry: new Date(contract.expiry.getTime()) };
}
