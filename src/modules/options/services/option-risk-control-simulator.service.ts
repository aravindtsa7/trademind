import {
  OptionRiskControlConfiguration,
  OptionRiskControlDailySummary,
  OptionRiskControlRejectionReason,
  OptionRiskControlSimulationRequest,
  OptionRiskControlSimulationResult,
  OptionRiskControlTradeInput,
  OptionRiskControlledTrade,
} from '../dto/option-risk-control-simulation.dto';

interface DailyState extends OptionRiskControlDailySummary {
  consecutiveLosses: number;
}

interface OpenPosition {
  trade: OptionRiskControlledTrade;
}

const marketDateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Kolkata',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const rejectionReasons: readonly OptionRiskControlRejectionReason[] = [
  'DAILY_LOSS_LIMIT',
  'MAX_TRADES_PER_DAY',
  'MAX_CONSECUTIVE_LOSSES',
  'COOL_OFF_AFTER_LOSS',
  'MAX_SIMULTANEOUS_POSITIONS',
  'DAILY_PROFIT_LOCK',
];

export default class OptionRiskControlSimulatorService {
  simulate(request: OptionRiskControlSimulationRequest): OptionRiskControlSimulationResult {
    this.validateRequest(request);
    const candidates = request.trades
      .map((trade, index) => ({ trade, index }))
      .sort((left, right) => left.trade.signalTimestamp.getTime() - right.trade.signalTimestamp.getTime() || left.index - right.index);
    const dailyStates = new Map<string, DailyState>();
    const decisions: OptionRiskControlledTrade[] = [];
    const openPositions: OpenPosition[] = [];
    let coolOffUntil: Date | null = null;

    const getDailyState = (date: string): DailyState => {
      const existing = dailyStates.get(date);
      if (existing) return existing;
      const created: DailyState = {
        tradingDate: date,
        candidateTrades: 0,
        acceptedTrades: 0,
        rejectedTrades: 0,
        wins: 0,
        losses: 0,
        realizedDailyPnl: 0,
        dailyLossLimitTriggered: false,
        profitLockTriggered: false,
        consecutiveLosses: 0,
      };
      dailyStates.set(date, created);
      return created;
    };

    const releaseThrough = (timestamp: Date): void => {
      const exits = openPositions
        .filter((position) => position.trade.exitTimestamp.getTime() <= timestamp.getTime())
        .sort((left, right) => left.trade.exitTimestamp.getTime() - right.trade.exitTimestamp.getTime());
      exits.forEach((position) => {
        const index = openPositions.indexOf(position);
        if (index < 0) return;
        openPositions.splice(index, 1);
        const state = getDailyState(this.getMarketDate(position.trade.exitTimestamp));
        state.realizedDailyPnl += position.trade.netPnl;
        if (position.trade.netPnl > 0) {
          state.wins += 1;
          state.consecutiveLosses = 0;
        } else if (position.trade.netPnl < 0) {
          state.losses += 1;
          state.consecutiveLosses += 1;
          if (request.configuration.coolOffMinutesAfterLoss !== undefined) {
            const until = new Date(position.trade.exitTimestamp.getTime() + request.configuration.coolOffMinutesAfterLoss * 60_000);
            if (!coolOffUntil || until.getTime() > coolOffUntil.getTime()) coolOffUntil = until;
          }
        }
        this.updateDailyTriggers(state, request.configuration);
      });
    };

    candidates.forEach(({ trade }) => {
      releaseThrough(trade.signalTimestamp);
      const state = getDailyState(this.getMarketDate(trade.signalTimestamp));
      state.candidateTrades += 1;
      const rejectionReason = this.getRejectionReason(state, trade.signalTimestamp, openPositions.length, coolOffUntil, request.configuration);
      const decision: OptionRiskControlledTrade = {
        ...trade,
        accepted: rejectionReason === null,
        rejectionReason,
      };
      decisions.push(decision);
      if (rejectionReason) {
        state.rejectedTrades += 1;
      } else {
        state.acceptedTrades += 1;
        openPositions.push({ trade: decision });
      }
    });

    releaseThrough(new Date(8_640_000_000_000_000));
    const acceptedTrades = decisions.filter((decision) => decision.accepted);
    const rejectedTrades = decisions.filter((decision) => !decision.accepted);
    const rejectionCounts = rejectionReasons.reduce<Record<OptionRiskControlRejectionReason, number>>((counts, reason) => {
      counts[reason] = rejectedTrades.filter((trade) => trade.rejectionReason === reason).length;
      return counts;
    }, {} as Record<OptionRiskControlRejectionReason, number>);

    return {
      acceptedTrades,
      rejectedTrades,
      decisions,
      dailySummaries: Array.from(dailyStates.values())
        .sort((left, right) => left.tradingDate.localeCompare(right.tradingDate))
        .map(({ consecutiveLosses: _consecutiveLosses, ...summary }) => summary),
      totalCandidates: decisions.length,
      totalAccepted: acceptedTrades.length,
      totalRejected: rejectedTrades.length,
      rejectionCounts,
    };
  }

  private getRejectionReason(
    state: DailyState,
    timestamp: Date,
    activePositions: number,
    coolOffUntil: Date | null,
    configuration: OptionRiskControlConfiguration
  ): OptionRiskControlRejectionReason | null {
    if (state.dailyLossLimitTriggered) return 'DAILY_LOSS_LIMIT';
    if (state.profitLockTriggered) return 'DAILY_PROFIT_LOCK';
    if (configuration.maxTradesPerDay !== undefined && state.acceptedTrades >= configuration.maxTradesPerDay) return 'MAX_TRADES_PER_DAY';
    if (configuration.maxConsecutiveLosses !== undefined && state.consecutiveLosses >= configuration.maxConsecutiveLosses) return 'MAX_CONSECUTIVE_LOSSES';
    if (coolOffUntil && timestamp.getTime() < coolOffUntil.getTime()) return 'COOL_OFF_AFTER_LOSS';
    if (configuration.maxSimultaneousPositions !== undefined && activePositions >= configuration.maxSimultaneousPositions) return 'MAX_SIMULTANEOUS_POSITIONS';
    return null;
  }

  private updateDailyTriggers(state: DailyState, configuration: OptionRiskControlConfiguration): void {
    if (configuration.maxDailyLossAmount !== undefined && state.realizedDailyPnl <= -configuration.maxDailyLossAmount) {
      state.dailyLossLimitTriggered = true;
    }
    if (configuration.dailyProfitLockAmount !== undefined && state.realizedDailyPnl >= configuration.dailyProfitLockAmount) {
      state.profitLockTriggered = true;
    }
  }

  private validateRequest(request: OptionRiskControlSimulationRequest): void {
    if (!request || typeof request !== 'object' || !Array.isArray(request.trades) || !request.configuration || typeof request.configuration !== 'object') {
      throw new Error('Option risk-control simulation requires valid trades and configuration.');
    }
    request.trades.forEach((trade) => this.validateTrade(trade));
    this.validateConfiguration(request.configuration);
  }

  private validateTrade(trade: OptionRiskControlTradeInput): void {
    if (!trade || typeof trade !== 'object' || !(trade.signalTimestamp instanceof Date) || Number.isNaN(trade.signalTimestamp.getTime()) ||
      !(trade.exitTimestamp instanceof Date) || Number.isNaN(trade.exitTimestamp.getTime()) || trade.exitTimestamp.getTime() < trade.signalTimestamp.getTime() ||
      !Number.isFinite(trade.netPnl) || !this.isNonEmptyString(trade.instrumentKey) || !this.isNonEmptyString(trade.tradingSymbol)) {
      throw new Error('Option risk-control simulation received an invalid evaluated trade.');
    }
  }

  private validateConfiguration(configuration: OptionRiskControlConfiguration): void {
    this.validatePositiveAmount(configuration.maxDailyLossAmount, 'maxDailyLossAmount');
    this.validatePositiveAmount(configuration.dailyProfitLockAmount, 'dailyProfitLockAmount');
    this.validatePositiveInteger(configuration.maxTradesPerDay, 'maxTradesPerDay');
    this.validatePositiveInteger(configuration.maxConsecutiveLosses, 'maxConsecutiveLosses');
    this.validatePositiveInteger(configuration.coolOffMinutesAfterLoss, 'coolOffMinutesAfterLoss', true);
    this.validatePositiveInteger(configuration.maxSimultaneousPositions, 'maxSimultaneousPositions');
  }

  private validatePositiveAmount(value: number | undefined, name: string): void {
    if (value !== undefined && (!Number.isFinite(value) || value <= 0)) throw new Error(`Option risk-control ${name} must be a positive finite number.`);
  }

  private validatePositiveInteger(value: number | undefined, name: string, allowZero = false): void {
    if (value !== undefined && (!Number.isInteger(value) || value < (allowZero ? 0 : 1))) throw new Error(`Option risk-control ${name} must be a ${allowZero ? 'non-negative' : 'positive'} integer.`);
  }

  private getMarketDate(timestamp: Date): string {
    const parts = Object.fromEntries(marketDateFormatter.formatToParts(timestamp).map((part) => [part.type, part.value]));
    return `${parts.year}-${parts.month}-${parts.day}`;
  }

  private isNonEmptyString(value: unknown): value is string {
    return typeof value === 'string' && value.trim().length > 0;
  }
}
