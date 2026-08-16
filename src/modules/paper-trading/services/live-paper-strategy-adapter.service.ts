import { EmaResult } from '../../indicators/indicators/ema.indicator';
import { RsiResult } from '../../indicators/indicators/rsi.indicator';
import { AdxResult } from '../../indicators/indicators/adx.indicator';
import IndicatorEngineService from '../../indicators/services/indicator-engine.service';
import { Candle, IndicatorType } from '../../indicators/types';
import { StrategySignal } from '../../strategies/dto/strategy-signal.dto';
import EmaCrossStrategy from '../../strategies/strategies/ema-cross.strategy';
import AdaptiveMarketRegimeService from '../../adaptive-intraday/services/adaptive-market-regime.service';
import { AdaptivePrimaryMarketRegime } from '../../adaptive-intraday/types/adaptive-market-regime.types';
import V2TrendDownEntryEvaluatorService from '../../adaptive-intraday/services/v2-trend-down-entry-evaluator.service';
import { RiskDeniedError } from '../../risk/runtime-risk-gate.service';
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
const v2ExitPolicy = { targetPercent: Number(process.env.V2_TARGET_PERCENT ?? 5), stopLossPercent: Number(process.env.V2_STOP_PERCENT ?? 5), maximumHoldingMinutes: Number(process.env.V2_MAX_HOLD_MINUTES ?? 15) };

/**
 * Consumes completed NIFTY five-minute candles for the frozen EMA15/EMA35 +
 * RSI14 candidate. It neither builds live candles nor owns market-data state.
 */
export default class LivePaperStrategyAdapterService {
  private readonly history: Candle[] = [];
  private readonly processedTimestamps = new Set<number>();
  private readonly seededHistoricalTimestamps = new Set<number>();
  private readonly v2 = process.env.TRADING_STRATEGY_VERSION === 'V2';
  private readonly v2Evaluator = new V2TrendDownEntryEvaluatorService();
  private readonly regimeService = new AdaptiveMarketRegimeService({ trendStrengthThreshold: 20, emaProximityPercent: 0.05, highVolatilityThreshold: 0.10, lowVolatilityThreshold: 0.05 });

  constructor(
    private readonly orchestrator: LivePaperOrchestrator,
    private readonly indicatorEngine: LivePaperIndicatorEngine = new IndicatorEngineService(),
    private readonly emaCrossStrategy: LivePaperEmaCrossStrategy = new EmaCrossStrategy({ fastPeriod, slowPeriod }),
    private readonly isV2PositionOpen: () => boolean = () => false,
  ) { if (this.v2 && process.env.PAPER_TRADING_ONLY !== 'true') throw new Error('V2 strategy is paper-only and requires PAPER_TRADING_ONLY=true.'); }

  /**
   * Adds completed historical candles without evaluating signals or invoking
   * orchestration. This method is intentionally available only before live
   * candle processing begins.
   */
  seedHistoricalCandles(candles: readonly Candle[]): void {
    if (!Array.isArray(candles) || candles.length === 0) {
      throw new Error('Historical warm-up requires at least one completed candle.');
    }
    if (this.history.length > 0 || this.processedTimestamps.size > 0) {
      throw new Error('Historical warm-up must complete before live candle processing begins.');
    }

    let previousTimestamp: number | undefined;
    candles.forEach((candle) => {
      this.validateCandle(candle);
      const timestamp = candle.timestamp.getTime();
      if (previousTimestamp !== undefined && timestamp <= previousTimestamp) {
        throw new Error(timestamp === previousTimestamp
          ? 'Historical warm-up candles must not contain duplicate timestamps.'
          : 'Historical warm-up candles must be in chronological order.');
      }
      previousTimestamp = timestamp;
    });

    candles.forEach((candle) => {
      const timestamp = candle.timestamp.getTime();
      this.history.push(cloneCandle(candle));
      this.seededHistoricalTimestamps.add(timestamp);
    });
  }

  isWarmupReady(): boolean {
    return this.history.length >= minimumHistory;
  }

  async processCompletedCandle(input: LivePaperCompletedCandleInput): Promise<LivePaperStrategyResult> {
    this.validateInput(input);
    const { candle } = input;
    const timestamp = candle.timestamp.getTime();

    if (!input.completed) {
      return this.noTradeResult(candle, false, false, ['Ignoring incomplete 5-minute candle.']);
    }
    if (this.seededHistoricalTimestamps.has(timestamp)) {
      return this.noTradeResult(candle, false, false, ['Ignoring live candle that overlaps seeded historical candle history.']);
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
        { type: IndicatorType.ADX, period: 14 }, { type: IndicatorType.ATR, period: 14 },
      ],
    });
    const fastEma = this.getEma(indicators, fastPeriod);
    const slowEma = this.getEma(indicators, slowPeriod);
    const rsi = this.getRsi(indicators);
    const latestRsi = rsi.values.find((entry) => entry.timestamp.getTime() === timestamp)?.value;
    if (latestRsi === undefined) throw new Error('RSI14 has no value for the completed candle timestamp.');

    if (this.v2) return this.processV2(input, indicators, fastEma, slowEma, latestRsi);
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

  /** Infrastructure-only reconnect repair: append unseen completed candles without evaluating or resetting frozen V2 cooldown state. */
  recoverHistoricalCandles(candles: readonly Candle[]): void {
    let latest = this.history.at(-1)?.timestamp.getTime() ?? Number.NEGATIVE_INFINITY;
    for (const candle of candles) {
      this.validateCandle(candle);
      const timestamp = candle.timestamp.getTime();
      if (this.seededHistoricalTimestamps.has(timestamp) || this.processedTimestamps.has(timestamp)) continue;
      if (timestamp <= latest) continue;
      this.history.push(cloneCandle(candle));
      this.seededHistoricalTimestamps.add(timestamp);
      latest = timestamp;
    }
  }

  private async processV2(input: LivePaperCompletedCandleInput, indicators: ReturnType<IndicatorEngineService['calculate']>, fastEma: EmaResult, slowEma: EmaResult, rsi14: number): Promise<LivePaperStrategyResult> {
    const candle = input.candle; const key = candle.timestamp.getTime(); const completedAt = new Date(key + 5 * 60_000); const adx = this.getAdx(indicators).values.find((value) => value.timestamp.getTime() === key); const atr = this.getScalar(indicators, IndicatorType.ATR, 14).values.find((value) => value.timestamp.getTime() === key)?.value; const ema15 = latestEma(fastEma); const ema35 = latestEma(slowEma);
    const regime = adx && atr !== undefined ? this.regimeService.classify({ timestamp: candle.timestamp, close: candle.close, ema15, ema35, rsi14, adx14: adx.adx, atr14: atr }).primaryRegime : undefined;
    const decision = this.v2Evaluator.evaluate({ completedCandleTimestamp: completedAt, regime, close: candle.close, high: candle.high, ema35, rsi14 }); const reasons = [`V2 ${decision.reason}: completedAt=${completedAt.toISOString()} regime=${regime ?? 'NOT_READY'} close=${candle.close} ema35=${ema35} proximity=${decision.proximityPercent ?? 'N/A'} rsi14=${rsi14} cooldownEligible=${decision.cooldownEligible}.`];
    if (!decision.entry) return { candleTimestamp: completedAt, spotPrice: candle.close, ema15, ema35, rsi14, rawEmaSignal: StrategySignal.NO_TRADE, timeFilterAllowed: true, finalSignal: StrategySignal.NO_TRADE, reasons, processed: true };
    if (this.isV2PositionOpen()) { reasons.push('V2_BLOCKED_POSITION_OPEN.'); return { candleTimestamp: completedAt, spotPrice: candle.close, ema15, ema35, rsi14, rawEmaSignal: StrategySignal.NO_TRADE, timeFilterAllowed: true, finalSignal: StrategySignal.NO_TRADE, reasons, processed: true }; }
    try { const orchestration = await this.orchestrator.createFromSignal({ signal: { signalTimestamp: completedAt, signalType: StrategySignal.BUY_PE, underlying: frozenUnderlying, spotPrice: candle.close }, contracts: input.contracts, exitPolicy: { ...v2ExitPolicy } }); reasons.push(`Paper order ${orchestration.order.id} opened for V2 BUY_PE.`); return { candleTimestamp: completedAt, spotPrice: candle.close, ema15, ema35, rsi14, rawEmaSignal: StrategySignal.BUY_PE, timeFilterAllowed: true, finalSignal: StrategySignal.BUY_PE, orchestration, reasons, processed: true }; }
    catch (error) { if (error instanceof RiskDeniedError) { reasons.push(`V2_RISK_DENIED:${error.decision.denialReasons.join('|')}`); return { candleTimestamp: completedAt, spotPrice: candle.close, ema15, ema35, rsi14, rawEmaSignal: StrategySignal.BUY_PE, timeFilterAllowed: true, finalSignal: StrategySignal.BUY_PE, reasons, processed: true }; } throw error; }
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
  private getAdx(indicators: ReturnType<IndicatorEngineService['calculate']>): AdxResult { const found = indicators.indicators.find((entry) => entry.config.type === IndicatorType.ADX && 'period' in entry.config && entry.config.period === 14)?.result; if (!found || !('values' in found)) throw new Error('ADX14 indicator result is missing.'); return found as AdxResult; }
  private getScalar(indicators: ReturnType<IndicatorEngineService['calculate']>, type: IndicatorType, period: number): { values: Array<{ timestamp: Date; value: number }> } { const found = indicators.indicators.find((entry) => entry.config.type === type && 'period' in entry.config && entry.config.period === period)?.result; if (!found || !('values' in found)) throw new Error(`${type}${period} indicator result is missing.`); return found as { values: Array<{ timestamp: Date; value: number }> }; }

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
    this.validateCandle(candle);
    if (!Array.isArray(input.contracts)) throw new Error('Option contracts must be an array.');
  }

  private validateCandle(candle: Candle): void {
    if (!(candle.timestamp instanceof Date) || Number.isNaN(candle.timestamp.getTime())) throw new Error('Candle timestamp must be valid.');
    ['open', 'high', 'low', 'close', 'volume'].forEach((field) => { if (!Number.isFinite(candle[field as keyof Candle] as number)) throw new Error(`Candle ${field} must be finite.`); });
    if (candle.close <= 0) throw new Error('Candle close must be positive.');
  }
}

function latestEma(result: EmaResult): number { const latest = result.values[result.values.length - 1]; if (!latest) throw new Error(`EMA${result.period} has no calculated values.`); return latest.value; }
function cloneCandle(candle: Candle): Candle { return { ...candle, timestamp: new Date(candle.timestamp.getTime()) }; }
