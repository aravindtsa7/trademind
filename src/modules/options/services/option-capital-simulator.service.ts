import { StrategySignal } from '../../strategies/dto/strategy-signal.dto';
import {
  OptionCapitalEquityEvent,
  OptionCapitalSimulationRequest,
  OptionCapitalSimulationResult,
  OptionCapitalSimulationTradeInput,
  SimulatedOptionTrade,
} from '../dto/option-capital-simulation.dto';

interface OpenPosition {
  record: SimulatedOptionTrade;
  exitTimestamp: Date;
}

export default class OptionCapitalSimulatorService {
  simulate(request: OptionCapitalSimulationRequest): OptionCapitalSimulationResult {
    this.validateRequest(request);

    const candidates = request.trades
      .map((trade, index) => ({ trade, index }))
      .sort((left, right) =>
        left.trade.signalTimestamp.getTime() - right.trade.signalTimestamp.getTime() || left.index - right.index
      );
    const records: SimulatedOptionTrade[] = [];
    const openPositions: OpenPosition[] = [];
    const equityEvents: OptionCapitalEquityEvent[] = [];
    let availableCash = request.initialCapital;
    let capitalDeployed = 0;
    let maximumCapitalDeployed = 0;
    let maximumSimultaneousPositions = 0;
    let minimumAvailableCash = availableCash;

    if (candidates.length > 0) {
      equityEvents.push(this.createEvent(candidates[0].trade.signalTimestamp, 'INITIAL', availableCash, capitalDeployed));
    }

    const releasePositionsThrough = (timestamp: Date): void => {
      openPositions
        .filter((position) => position.exitTimestamp.getTime() <= timestamp.getTime())
        .sort((left, right) => left.exitTimestamp.getTime() - right.exitTimestamp.getTime())
        .forEach((position) => {
          const positionIndex = openPositions.indexOf(position);
          if (positionIndex < 0) return;
          openPositions.splice(positionIndex, 1);
          capitalDeployed -= position.record.capitalLocked;
          availableCash += position.record.capitalLocked + position.record.netPnl;
          position.record.capitalAfterExit = availableCash;
          minimumAvailableCash = Math.min(minimumAvailableCash, availableCash);
          equityEvents.push(this.createEvent(position.exitTimestamp, 'EXIT', availableCash, capitalDeployed, position.record.instrumentKey));
        });
    };

    candidates.forEach(({ trade }) => {
      releasePositionsThrough(trade.signalTimestamp);
      const capitalLocked = trade.entryValue + (trade.entryCharges ?? 0);
      const capitalBefore = availableCash;
      // The second check prevents a known historical loss (including deferred
      // round-trip charges) from taking cash below zero at settlement.
      if (availableCash < capitalLocked || availableCash + trade.netPnl < 0) {
        records.push({
          ...trade,
          executed: false,
          capitalBefore,
          capitalLocked: 0,
          availableCashAfterEntry: availableCash,
          capitalAfterExit: null,
          rejectionReason: 'INSUFFICIENT_CAPITAL',
        });
        return;
      }

      availableCash -= capitalLocked;
      capitalDeployed += capitalLocked;
      minimumAvailableCash = Math.min(minimumAvailableCash, availableCash);
      maximumCapitalDeployed = Math.max(maximumCapitalDeployed, capitalDeployed);
      const record: SimulatedOptionTrade = {
        ...trade,
        executed: true,
        capitalBefore,
        capitalLocked,
        availableCashAfterEntry: availableCash,
        capitalAfterExit: null,
        rejectionReason: null,
      };
      records.push(record);
      openPositions.push({ record, exitTimestamp: trade.exitTimestamp });
      maximumSimultaneousPositions = Math.max(maximumSimultaneousPositions, openPositions.length);
      equityEvents.push(this.createEvent(trade.signalTimestamp, 'ENTRY', availableCash, capitalDeployed, trade.instrumentKey));
    });

    releasePositionsThrough(new Date(8_640_000_000_000_000));

    const executed = records.filter((record) => record.executed);
    const equity = this.calculateEquityMetrics(equityEvents, request.initialCapital);
    return {
      initialCapital: request.initialCapital,
      finalCapital: availableCash,
      totalNetPnl: executed.reduce((sum, record) => sum + record.netPnl, 0),
      returnPercent: ((availableCash - request.initialCapital) / request.initialCapital) * 100,
      totalCandidateTrades: records.length,
      executedTrades: executed.length,
      rejectedTrades: records.length - executed.length,
      profitableTrades: executed.filter((record) => record.netPnl > 0).length,
      losingTrades: executed.filter((record) => record.netPnl < 0).length,
      maximumCapitalDeployed,
      averageCapitalDeployed: this.calculateAverageCapitalDeployed(equityEvents),
      maximumSimultaneousPositions,
      minimumAvailableCash,
      insufficientCapitalRejectedTrades: records.filter((record) => record.rejectionReason === 'INSUFFICIENT_CAPITAL').length,
      equityEvents,
      peakEquity: equity.peak,
      minimumEquity: equity.minimum,
      maximumDrawdownAmount: equity.maximumDrawdownAmount,
      maximumDrawdownPercent: equity.maximumDrawdownPercent,
      trades: records,
    };
  }

  private validateRequest(request: OptionCapitalSimulationRequest): void {
    if (!request || typeof request !== 'object' || !Number.isFinite(request.initialCapital) || request.initialCapital <= 0) {
      throw new Error('Option capital simulation requires a positive finite initialCapital.');
    }
    if (!Array.isArray(request.trades)) {
      throw new Error('Option capital simulation requires a trades array.');
    }
    request.trades.forEach((trade) => this.validateTrade(trade));
  }

  private validateTrade(trade: OptionCapitalSimulationTradeInput): void {
    if (!trade || typeof trade !== 'object') throw new Error('Option capital simulation received an invalid trade.');
    if (!(trade.signalTimestamp instanceof Date) || Number.isNaN(trade.signalTimestamp.getTime()) ||
      !(trade.exitTimestamp instanceof Date) || Number.isNaN(trade.exitTimestamp.getTime()) ||
      trade.exitTimestamp.getTime() < trade.signalTimestamp.getTime()) {
      throw new Error('Option capital simulation trade requires chronological valid entry and exit timestamps.');
    }
    if (trade.signalType !== StrategySignal.BUY_CE && trade.signalType !== StrategySignal.BUY_PE) {
      throw new Error('Option capital simulation trade has an unsupported signal type.');
    }
    if (!this.isNonEmptyString(trade.instrumentKey) || !this.isNonEmptyString(trade.tradingSymbol)) {
      throw new Error('Option capital simulation trade requires instrument metadata.');
    }
    if (!Number.isInteger(trade.quantity) || trade.quantity <= 0) {
      throw new Error('Option capital simulation trade requires a positive integer one-lot quantity.');
    }
    if (!Number.isFinite(trade.entryPremium) || trade.entryPremium <= 0 ||
      !Number.isFinite(trade.exitPremium) || trade.exitPremium < 0 ||
      !Number.isFinite(trade.entryValue) || trade.entryValue <= 0 ||
      !Number.isFinite(trade.totalCharges) || trade.totalCharges < 0 ||
      !Number.isFinite(trade.netPnl) ||
      (trade.entryCharges !== undefined && (!Number.isFinite(trade.entryCharges) || trade.entryCharges < 0))) {
      throw new Error('Option capital simulation trade contains invalid monetary values.');
    }
  }

  private createEvent(
    timestamp: Date,
    type: OptionCapitalEquityEvent['type'],
    availableCash: number,
    capitalDeployed: number,
    instrumentKey?: string
  ): OptionCapitalEquityEvent {
    return { timestamp: new Date(timestamp.getTime()), type, instrumentKey, availableCash, capitalDeployed, equity: availableCash + capitalDeployed };
  }

  private calculateAverageCapitalDeployed(events: readonly OptionCapitalEquityEvent[]): number {
    if (events.length < 2) return 0;
    let weightedCapital = 0;
    let duration = 0;
    for (let index = 0; index < events.length - 1; index += 1) {
      const interval = events[index + 1].timestamp.getTime() - events[index].timestamp.getTime();
      weightedCapital += events[index].capitalDeployed * interval;
      duration += interval;
    }
    return duration === 0 ? 0 : weightedCapital / duration;
  }

  private calculateEquityMetrics(events: readonly OptionCapitalEquityEvent[], initialCapital: number): {
    peak: number;
    minimum: number;
    maximumDrawdownAmount: number;
    maximumDrawdownPercent: number;
  } {
    let peak = initialCapital;
    let minimum = initialCapital;
    let maximumDrawdownAmount = 0;
    let maximumDrawdownPercent = 0;
    events.forEach((event) => {
      peak = Math.max(peak, event.equity);
      minimum = Math.min(minimum, event.equity);
      const drawdown = peak - event.equity;
      maximumDrawdownAmount = Math.max(maximumDrawdownAmount, drawdown);
      maximumDrawdownPercent = Math.max(maximumDrawdownPercent, peak === 0 ? 0 : (drawdown / peak) * 100);
    });
    return { peak, minimum, maximumDrawdownAmount, maximumDrawdownPercent };
  }

  private isNonEmptyString(value: unknown): value is string {
    return typeof value === 'string' && value.trim().length > 0;
  }
}
