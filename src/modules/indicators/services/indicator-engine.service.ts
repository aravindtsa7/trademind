import AdxIndicator, { AdxConfig, AdxResult } from '../indicators/adx.indicator';
import AtrIndicator, { AtrConfig, AtrResult } from '../indicators/atr.indicator';
import BollingerBandsIndicator, {
  BollingerBandsConfig,
  BollingerBandsResult,
} from '../indicators/bollinger-bands.indicator';
import EmaIndicator, { EmaConfig, EmaResult } from '../indicators/ema.indicator';
import MacdIndicator, { MacdConfig, MacdResult } from '../indicators/macd.indicator';
import RsiIndicator, { RsiConfig, RsiResult } from '../indicators/rsi.indicator';
import SmaIndicator, { SmaConfig, SmaResult } from '../indicators/sma.indicator';
import SuperTrendIndicator, {
  SuperTrendConfig,
  SuperTrendResult,
} from '../indicators/supertrend.indicator';
import VwapIndicator, { VwapConfig, VwapResult } from '../indicators/vwap.indicator';
import { Candle, IndicatorType } from '../types';

export type SupportedIndicatorConfig =
  | SmaConfig
  | EmaConfig
  | RsiConfig
  | VwapConfig
  | AtrConfig
  | MacdConfig
  | BollingerBandsConfig
  | AdxConfig
  | SuperTrendConfig;
export type SupportedIndicatorResult =
  | SmaResult
  | EmaResult
  | RsiResult
  | VwapResult
  | AtrResult
  | MacdResult
  | BollingerBandsResult
  | AdxResult
  | SuperTrendResult;

export interface IndicatorEngineRequest {
  indicators: readonly SupportedIndicatorConfig[];
}

export interface IndicatorEngineResult {
  indicators: Array<{
    config: SupportedIndicatorConfig;
    result: SupportedIndicatorResult;
  }>;
}

export default class IndicatorEngineService {
  calculate(candles: readonly Candle[], request: IndicatorEngineRequest): IndicatorEngineResult {
    this.validateRequests(request.indicators);

    return {
      indicators: request.indicators.map((config) => ({
        config,
        result: this.calculateIndicator(candles, config),
      })),
    };
  }

  private validateRequests(configs: readonly SupportedIndicatorConfig[]): void {
    const requestKeys = new Set<string>();

    configs.forEach((config) => {
      this.assertSupportedType(config.type);

      const requestKey = this.getRequestKey(config);
      if (requestKeys.has(requestKey)) {
        throw new Error(this.getDuplicateRequestMessage(config));
      }

      requestKeys.add(requestKey);
    });
  }

  private calculateIndicator(
    candles: readonly Candle[],
    config: SupportedIndicatorConfig
  ): SupportedIndicatorResult {
    switch (config.type) {
      case IndicatorType.SMA:
        return new SmaIndicator().calculate(candles, config);
      case IndicatorType.EMA:
        return new EmaIndicator().calculate(candles, config);
      case IndicatorType.RSI:
        return new RsiIndicator().calculate(candles, config);
      case IndicatorType.VWAP:
        return new VwapIndicator().calculate(candles, config);
      case IndicatorType.ATR:
        return new AtrIndicator().calculate(candles, config);
      case IndicatorType.MACD:
        return new MacdIndicator().calculate(candles, config);
      case IndicatorType.BOLLINGER_BANDS:
        return new BollingerBandsIndicator().calculate(candles, config);
      case IndicatorType.ADX:
        return new AdxIndicator().calculate(candles, config);
      case IndicatorType.SUPER_TREND:
        return new SuperTrendIndicator().calculate(candles, config);
      default:
        return this.throwUnsupportedType(String((config as { type: unknown }).type));
    }
  }

  private assertSupportedType(type: IndicatorType): void {
    if (
      type !== IndicatorType.SMA &&
      type !== IndicatorType.EMA &&
      type !== IndicatorType.RSI &&
      type !== IndicatorType.VWAP &&
      type !== IndicatorType.ATR &&
      type !== IndicatorType.MACD &&
      type !== IndicatorType.BOLLINGER_BANDS &&
      type !== IndicatorType.ADX &&
      type !== IndicatorType.SUPER_TREND
    ) {
      this.throwUnsupportedType(type);
    }
  }

  private getRequestKey(config: SupportedIndicatorConfig): string {
    switch (config.type) {
      case IndicatorType.MACD:
        return `${config.type}:${config.fastPeriod}:${config.slowPeriod}:${config.signalPeriod}`;
      case IndicatorType.BOLLINGER_BANDS:
        return `${config.type}:${config.period}:${config.standardDeviationMultiplier}`;
      case IndicatorType.SUPER_TREND:
        return `${config.type}:${config.period}:${config.multiplier}`;
      case IndicatorType.SMA:
      case IndicatorType.EMA:
      case IndicatorType.RSI:
      case IndicatorType.ATR:
      case IndicatorType.ADX:
        return `${config.type}:${config.period}`;
      case IndicatorType.VWAP:
        return config.type;
      default:
        return this.throwUnsupportedType(String((config as { type: unknown }).type));
    }
  }

  private getDuplicateRequestMessage(config: SupportedIndicatorConfig): string {
    return `Duplicate indicator request: ${this.getRequestKey(config)}.`;
  }

  private throwUnsupportedType(type: string): never {
    throw new Error(`Unsupported indicator type: ${type}`);
  }
}
