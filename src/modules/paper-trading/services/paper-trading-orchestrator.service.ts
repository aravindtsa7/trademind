import { MarketDataSubscriptionMode } from '../../market-data/managers/subscription.manager';
import OptionContractSelectorService from '../../options/services/option-contract-selector.service';
import { OptionContract, OptionContractSelectionResult } from '../../options/types';
import { StrategySignal } from '../../strategies/dto/strategy-signal.dto';
import { PaperOrderStatus } from '../types/paper-trading.types';
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
import ExecutionEngineService, { DuplicateExecutionIntentError } from '../../execution/execution-engine.service';
import PrismaExecutionRepository from '../../execution/prisma-execution.repository';
import { ExecutionFaultInjector, noExecutionFaults } from '../../execution/execution-fault-injection';
import { ExecutionQuoteSnapshot, PaperExecutionFillResult } from '../dto/paper-fill-model.dto';

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
  buildIntent(input: { signal: PaperTradingOrchestrationRequest['signal']; contract: OptionContract; observedEntryPremium: number; executionQuote?: ExecutionQuoteSnapshot }): RuntimeRiskIntent;
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
    private readonly executionEngine?: ExecutionEngineService,
    private readonly prismaExecution?: PrismaExecutionRepository,
    private readonly faultInjector: ExecutionFaultInjector = noExecutionFaults,
  ) {}

  async createFromSignal(request: PaperTradingOrchestrationRequest): Promise<PaperTradingOrchestrationResult> {
    this.validateRequest(request);
    await this.faultInjector.hit('AFTER_SIGNAL_BEFORE_RISK', { strategyId: 'V2_TREND_DOWN_PE' });
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

    let observedEntryPremium: number; let capturedExecutionQuote: ExecutionQuoteSnapshot | undefined;
    try {
      const observation = request.observedEntryPremium === undefined ? await this.premiumProvider.getObservedPremium(selectedContract.instrumentKey) : request.observedEntryPremium;
      if (typeof observation === 'number') observedEntryPremium = observation;
      else { observedEntryPremium = observation.observedEntryPremium; capturedExecutionQuote = observation.executionQuote; }
    }
    catch (error) {
      if (error instanceof PaperEntryQuoteWaitError && this.riskGate && this.riskContextProvider) {
        const context = this.riskContextProvider.buildIntent({ signal, contract: selectedContract, observedEntryPremium: Number.NaN });
        const { entryPremium: _entryPremium, quantity: _quantity, ...external } = context;
        const decision = this.riskGate.denyExternal(external, error.reason);
        logger.info('RISK_DECISION', decision);
        this.logExecutionAttempt(signal, selectedContract.instrumentKey, undefined, decision, undefined, 'QUOTE_ACQUISITION_DENIED');
        throw new RiskDeniedError(decision);
      }
      throw error;
    }
    if (!Number.isFinite(observedEntryPremium) || observedEntryPremium <= 0) {
      throw new Error('Observed entry premium must be positive and finite.');
    }
    if (this.fillModel && capturedExecutionQuote && this.fillModel.executionLatencyMs > 0) {
      if (!this.executionQuoteProvider) throw new Error('Paper fill model is configured without an execution quote provider.');
      const eligibleAt = new Date(signal.signalTimestamp.getTime() + this.fillModel.executionLatencyMs);
      capturedExecutionQuote = await this.executionQuoteProvider.waitForExecutionQuote?.(selectedContract.instrumentKey, eligibleAt, Number(process.env.PAPER_FILL_WAIT_MS ?? 2_000)) ?? capturedExecutionQuote;
    }
    let approvedDecision: ReturnType<RuntimeRiskGateService['evaluate']> | undefined;
    if (this.riskGate) {
      if (!this.riskContextProvider) throw new Error('Risk gate is configured without a risk context provider.');
      approvedDecision = this.riskGate.evaluate(this.riskContextProvider.buildIntent({ signal, contract: selectedContract, observedEntryPremium, executionQuote:capturedExecutionQuote }));
      logger.info('RISK_DECISION', approvedDecision);
      if (approvedDecision.decision === 'DENIED') { this.logExecutionAttempt(signal, selectedContract.instrumentKey, capturedExecutionQuote, approvedDecision, undefined, 'RISK_DENIED'); throw new RiskDeniedError(approvedDecision); }
    }
    await this.faultInjector.hit('AFTER_RISK_APPROVAL_BEFORE_EXECUTION', { intentId: approvedDecision?.intentId ?? null });

    let executionFill;
    let filledQuantity = selectedContract.lotSize as number;
    let simulatedEntryPremium = observedEntryPremium;
    let executionOrderId: string | undefined;
    let riskContext: RuntimeRiskIntent | undefined;
    if (this.executionEngine && !this.prismaExecution) {
      if (!approvedDecision || !this.riskContextProvider) throw new Error('Durable execution requires an approved risk decision and risk context.');
      riskContext = this.riskContextProvider.buildIntent({ signal, contract: selectedContract, observedEntryPremium, executionQuote:capturedExecutionQuote });
      if (this.executionEngine.getByIntent(approvedDecision.intentId, riskContext.sessionDate)) throw new DuplicateExecutionIntentError(approvedDecision.intentId);
      executionOrderId = this.executionEngine.createRiskApprovedOrder({ intentId:approvedDecision.intentId, strategyId:riskContext.strategyId, runtimeId:riskContext.runtimeId, sessionDate:riskContext.sessionDate, instrumentKey:riskContext.instrument, side:riskContext.side, quantity:riskContext.quantity, requestedPrice:observedEntryPremium, executionMode:'PAPER', timestamp:riskContext.timestamp.toISOString(), correlationId:approvedDecision.correlationId }).executionOrderId;
    }
    if (this.fillModel) {
      if (!this.executionQuoteProvider) throw new Error('Paper fill model is configured without an execution quote provider.');
      const eligibleAt = new Date(signal.signalTimestamp.getTime() + this.fillModel.executionLatencyMs);
      let quote = capturedExecutionQuote ?? this.executionQuoteProvider.getExecutionQuoteSnapshot(selectedContract.instrumentKey);
      if (this.fillModel.executionLatencyMs > 0 && !capturedExecutionQuote) quote = await this.executionQuoteProvider.waitForExecutionQuote?.(selectedContract.instrumentKey, eligibleAt, Number(process.env.PAPER_FILL_WAIT_MS ?? 2_000)) ?? quote;
      const fill = this.fillModel.fill({ side:'BUY', requestedQuantity:selectedContract.lotSize as number, quote, intentTimestamp:signal.signalTimestamp, activeGenerationId:this.executionQuoteProvider.getActiveLiveGenerationId?.() });
      executionFill = this.fillModel.toSummary(fill);
      if (!executionFill) { if (executionOrderId && riskContext) this.executionEngine?.reject(executionOrderId, riskContext.sessionDate, `PAPER_FILL_${fill.status}`); this.logExecutionAttempt(signal, selectedContract.instrumentKey, quote, approvedDecision, fill, 'FILL_UNAVAILABLE'); logger.warn('PAPER_FILL_UNAVAILABLE', { strategyId: approvedDecision?.strategyId, instrument: selectedContract.instrumentKey, snapshotId:quote?.snapshotId ?? null, status:fill.status, reason:fill.reason, fillQuality:fill.fillQuality }); throw new PaperFillUnavailableError(fill); }
      this.logExecutionAttempt(signal, selectedContract.instrumentKey, quote, approvedDecision, fill, 'FILLED');
      await this.faultInjector.hit('AFTER_FILL_ESTIMATE_BEFORE_DB_TRANSACTION', { intentId: approvedDecision?.intentId ?? null, snapshotId: quote?.snapshotId ?? null });
      filledQuantity = executionFill.filledQuantity;
      simulatedEntryPremium = executionFill.averageFillPrice;
      if (executionOrderId && riskContext) this.executionEngine?.recordEntryFill(executionOrderId, riskContext.sessionDate, executionFill, signal.signalTimestamp);
    }
    if (this.prismaExecution) {
      if (!approvedDecision || !this.riskContextProvider || !executionFill) throw new Error('Prisma execution requires an approved decision, risk context, and executable fill.');
      riskContext = this.riskContextProvider.buildIntent({ signal, contract:selectedContract, observedEntryPremium, executionQuote:capturedExecutionQuote });
      executionOrderId = PrismaExecutionRepository.executionOrderId(approvedDecision.intentId);
    }
    const pending = this.orderManager.create({
      executionOrderId,
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
    if (this.prismaExecution && approvedDecision && riskContext && executionFill) {
      try {
        await this.prismaExecution.createPaperEntry({ intent:{ intentId:approvedDecision.intentId, strategyId:riskContext.strategyId, runtimeId:riskContext.runtimeId, sessionDate:riskContext.sessionDate, instrumentKey:riskContext.instrument, side:riskContext.side, quantity:riskContext.quantity, requestedPrice:observedEntryPremium, executionMode:'PAPER', timestamp:riskContext.timestamp.toISOString(), correlationId:approvedDecision.correlationId }, order:pending, underlying:riskContext.underlying, fill:executionFill });
      } catch (error) {
        this.orderManager.updateStatus(pending.id, PaperOrderStatus.CANCELLED);
        throw error;
      }
      await this.faultInjector.hit('AFTER_ENTRY_DB_COMMIT_BEFORE_LOCAL_ACK', { intentId: approvedDecision.intentId, executionOrderId });
    }
    const order = this.orderManager.markOpen(pending.id);
    if (executionOrderId && riskContext) this.executionEngine?.attachPaperOrder(executionOrderId, riskContext.sessionDate, order.id);
    if (this.portfolio) {
      const context = this.riskContextProvider?.buildIntent({ signal, contract: selectedContract, observedEntryPremium, executionQuote:capturedExecutionQuote });
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

  private logExecutionAttempt(signal: PaperTradingOrchestrationRequest['signal'], instrument: string, quote: ExecutionQuoteSnapshot | undefined, decision: ReturnType<RuntimeRiskGateService['evaluate']> | undefined, fill: PaperExecutionFillResult | undefined, outcome: string): void {
    logger.info('PAPER_EXECUTION_ATTEMPT', { strategyId:decision?.strategyId ?? null, instrument, signalTimestamp:signal.signalTimestamp.toISOString(), correlationId:decision?.correlationId ?? null, intentId:decision?.intentId ?? null, quoteSnapshotId:quote?.snapshotId ?? null, ltp:quote?.ltp ?? null, bestBid:quote?.bestBid ?? null, bestAsk:quote?.bestAsk ?? null, executableDepthQuantity:quote?.askSize ?? null, ltpAgeMs:quote?.ltpAgeMs ?? null, bidAgeMs:quote?.bidAgeMs ?? null, askAgeMs:quote?.askAgeMs ?? null, snapshotAgeMs:quote?.quoteAgeMs ?? null, riskResult:decision?.decision ?? null, riskDenialReasons:decision?.denialReasons ?? [], paperFillStatus:fill?.status ?? null, paperFillReason:fill?.reason ?? null, finalExecutionOutcome:outcome });
  }
}

function cloneContract(contract: OptionContract): OptionContract {
  return { ...contract, expiry: new Date(contract.expiry.getTime()) };
}
