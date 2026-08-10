import { MarketDataSubscriptionMode } from '../../market-data/managers/subscription.manager';
import OptionContractSelectorService from '../../options/services/option-contract-selector.service';
import { OptionContract, OptionContractSelectionResult } from '../../options/types';
import { StrategySignal } from '../../strategies/dto/strategy-signal.dto';
import {
  PaperEntryPremiumProvider,
  PaperMarketDataSubscriptionGateway,
  PaperTradingOrchestrationRequest,
  PaperTradingOrchestrationResult,
} from '../dto/paper-trading-orchestrator.dto';
import PaperOrderManagerService from './paper-order-manager.service';

interface OptionContractSelector {
  select(request: {
    underlying: string;
    spotPrice: number;
    signal: StrategySignal.BUY_CE | StrategySignal.BUY_PE;
    timestamp: Date;
    contracts: readonly OptionContract[];
  }): OptionContractSelectionResult;
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
    private readonly subscriptionMode: MarketDataSubscriptionMode = MarketDataSubscriptionMode.FULL
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

    const observedEntryPremium = request.observedEntryPremium ?? await this.premiumProvider.getObservedPremium(selectedContract.instrumentKey);
    if (!Number.isFinite(observedEntryPremium) || observedEntryPremium <= 0) {
      throw new Error('Observed entry premium must be positive and finite.');
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
        quantity: selectedContract.lotSize as number,
      },
      entry: {
        entryTimestamp: signal.signalTimestamp,
        observedEntryPremium,
        simulatedEntryPremium: observedEntryPremium,
      },
      exitConfiguration: { ...request.exitPolicy },
    });
    const order = this.orderManager.markOpen(pending.id);

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
