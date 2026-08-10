import { EmaResult } from '../../indicators/indicators/ema.indicator';
import { RsiResult } from '../../indicators/indicators/rsi.indicator';
import IndicatorEngineService from '../../indicators/services/indicator-engine.service';
import { Candle, IndicatorType } from '../../indicators/types';
import { StrategySignal } from '../../strategies/dto/strategy-signal.dto';
import EmaCrossStrategy from '../../strategies/strategies/ema-cross.strategy';
import {
  LivePaperCompletedCandleInput,
  LivePaperEmaCrossStrategy,
  LivePaperIndicatorEngine,
  LivePaperOrchestrator,
  LivePaperStrategyResult,
} from '../dto/live-paper-strategy.dto';

const fastPeriod = 15;
const slowPeriod = 35;
const rsiPeriod = 14;
const minimumHistory = slowPeriod + 1;
const frozenUnderlying = 'NIFTY 50';
const frozenExitPolicy = { targetPercent: 30, stopLossPercent: 20, maximumHoldingMinutes: 60 };

/**
 * Consumes completed NIFTY five-minute candles for the frozen EMA15/EMA35 +
 * RSI14 candidate. It neither builds live candles nor owns market-data state.
 */
export default class LivePaperStrategyAdapterService {
  private readonly history: Candle[] = [];
  private readonly processedTimestamps = new Set<number>();

  constructor(
    private readonly orchestrator: LivePaperOrchestrator,
    private readonly indicatorEngine: LivePaperIndicatorEngine = new IndicatorEngineService(),
    private readonly emaCrossStrategy: LivePaperEmaCrossStrategy = new EmaCrossStrategy({ fastPeriod, slowPeriod })
  ) {}

  async processCompletedCandle(input: LivePaperCompletedCandleInput): Promise<LivePaperStrategyResult> {
    this.validateInput(input);
    const { candle } = input;
    const timestamp = candle.timestamp.getTime();

    if (!input.completed) {
      return this.noTradeResult(candle, false, false, ['Ignoring incomplete 5-minute candle.']);
    }
    if (this.processedTimestamps.has(timestamp)) {
      return this.noTradeResult(candle, false, false, ['Ignoring duplicate completed candle timestamp.']);
    }
    if (this.history.length > 0 && timestamp <= this.history[this.history.length - 1].timestamp.getTime()) {
      throw new Error('Completed candles must be supplied in chronological order.');
    }

    this.processedTimestamps.add(timestamp);
    this.history.push(cloneCandle(candle));
    if (this.history.length < minimumHistory) {
      return this.noTradeResult(candle, false, true, [`Insufficient completed candle history: ${this.history.length}/${minimumHistory}.`]);
    }

    const indicators = this.indicatorEngine.calculate(this.history, {
      indicators: [
        { type: IndicatorType.EMA, period: fastPeriod },
        { type: IndicatorType.EMA, period: slowPeriod },
        { type: IndicatorType.RSI, period: rsiPeriod },
      ],
    });
    const fastEma = this.getEma(indicators, fastPeriod);
    const slowEma = this.getEma(indicators, slowPeriod);
    const rsi = this.getRsi(indicators);
    const latestRsi = rsi.values.find((entry) => entry.timestamp.getTime() === timestamp)?.value;
    if (latestRsi === undefined) throw new Error('RSI14 has no value for the completed candle timestamp.');

    const raw = this.emaCrossStrategy.evaluate({ fastEma, slowEma }) as { signal: StrategySignal; reasons: string[] };
    const timeFilterAllowed = this.isAllowedMarketTime(candle.timestamp);
    let finalSignal = StrategySignal.NO_TRADE;
    const reasons = [...raw.reasons];

    if (raw.signal === StrategySignal.BUY_CE && latestRsi <= 55) reasons.push('Bullish EMA crossover rejected: RSI14 must be greater than 55.');
    else if (raw.signal === StrategySignal.BUY_PE && latestRsi >= 45) reasons.push('Bearish EMA crossover rejected: RSI14 must be less than 45.');
    else if (raw.signal === StrategySignal.BUY_CE || raw.signal === StrategySignal.BUY_PE) finalSignal = raw.signal;

    if (!timeFilterAllowed && (raw.signal === StrategySignal.BUY_CE || raw.signal === StrategySignal.BUY_PE)) {
      finalSignal = StrategySignal.NO_TRADE;
      reasons.push('Signal rejected by frozen IST time filter (10:30-12:00).');
    }

    if (finalSignal === StrategySignal.NO_TRADE) {
      return {
        candleTimestamp: new Date(timestamp), spotPrice: candle.close, ema15: latestEma(fastEma), ema35: latestEma(slowEma), rsi14: latestRsi,
        rawEmaSignal: raw.signal, timeFilterAllowed, finalSignal, reasons, processed: true,
      };
    }

    const orchestration = await this.orchestrator.createFromSignal({
      signal: { signalTimestamp: new Date(timestamp), signalType: finalSignal, underlying: frozenUnderlying, spotPrice: candle.close },
      contracts: input.contracts,
      exitPolicy: { ...frozenExitPolicy },
    });
    reasons.push(`Paper order ${orchestration.order.id} opened for ${finalSignal}.`);
    return {
      candleTimestamp: new Date(timestamp), spotPrice: candle.close, ema15: latestEma(fastEma), ema35: latestEma(slowEma), rsi14: latestRsi,
      rawEmaSignal: raw.signal, timeFilterAllowed, finalSignal, orchestration, reasons, processed: true,
    };
  }

  private getEma(indicators: ReturnType<IndicatorEngineService['calculate']>, period: number): EmaResult {
    const found = indicators.indicators.find((entry) => entry.config.type === IndicatorType.EMA && 'period' in entry.config && entry.config.period === period)?.result;
    if (!found || !('period' in found) || !('values' in found) || found.period !== period) throw new Error(`EMA${period} indicator result is missing.`);
    return found as EmaResult;
  }

  private getRsi(indicators: ReturnType<IndicatorEngineService['calculate']>): RsiResult {
    const found = indicators.indicators.find((entry) => entry.config.type === IndicatorType.RSI && 'period' in entry.config && entry.config.period === rsiPeriod)?.result;
    if (!found || !('period' in found) || !('values' in found) || found.period !== rsiPeriod) throw new Error('RSI14 indicator result is missing.');
    return found as RsiResult;
  }

  private isAllowedMarketTime(timestamp: Date): boolean {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(timestamp).map((part) => [part.type, part.value]));
    const minute = Number(parts.hour) * 60 + Number(parts.minute);
    return (minute >= 9 * 60 + 15 && minute < 10 * 60 + 30) || (minute >= 12 * 60 && minute < 15 * 60 + 30);
  }

  private noTradeResult(candle: Candle, timeFilterAllowed: boolean, processed: boolean, reasons: string[]): LivePaperStrategyResult {
    return { candleTimestamp: new Date(candle.timestamp.getTime()), spotPrice: candle.close, ema15: null, ema35: null, rsi14: null, rawEmaSignal: StrategySignal.NO_TRADE, timeFilterAllowed, finalSignal: StrategySignal.NO_TRADE, reasons, processed };
  }

  private validateInput(input: LivePaperCompletedCandleInput): void {
    if (!input || typeof input !== 'object' || !input.candle) throw new Error('Completed candle input is required.');
    const candle = input.candle;
    if (!(candle.timestamp instanceof Date) || Number.isNaN(candle.timestamp.getTime())) throw new Error('Candle timestamp must be valid.');
    ['open', 'high', 'low', 'close', 'volume'].forEach((field) => { if (!Number.isFinite(candle[field as keyof Candle] as number)) throw new Error(`Candle ${field} must be finite.`); });
    if (candle.close <= 0) throw new Error('Candle close must be positive.');
    if (!Array.isArray(input.contracts)) throw new Error('Option contracts must be an array.');
  }
}

function latestEma(result: EmaResult): number { const latest = result.values[result.values.length - 1]; if (!latest) throw new Error(`EMA${result.period} has no calculated values.`); return latest.value; }
function cloneCandle(candle: Candle): Candle { return { ...candle, timestamp: new Date(candle.timestamp.getTime()) }; }
