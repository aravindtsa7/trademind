import { StrategySignal } from '../../strategies/dto/strategy-signal.dto';
import { ExpiredOptionCandleDto } from '../dto/upstox-expired-option-candle.dto';
import {
  OptionOutcomeDto,
  OptionOutcomeEvaluationRequest,
  OptionPremiumMovementDto,
} from '../dto/option-outcome.dto';

const horizons = [5, 15, 30, 60] as const;
const marketDateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Kolkata',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

export default class OptionOutcomeEvaluatorService {
  evaluate(request: OptionOutcomeEvaluationRequest): OptionOutcomeDto {
    this.validateRequest(request);

    const signalDate = this.getMarketDate(request.signalTimestamp);
    const sessionCandles = request.candles.filter(
      (candle) => this.getMarketDate(candle.candleTime) === signalDate
    );
    const entryCandle = sessionCandles.find(
      (candle) => candle.candleTime.getTime() === request.signalTimestamp.getTime()
    );
    if (!entryCandle) {
      throw new Error(`Option outcome evaluation cannot find a candle at ${request.signalTimestamp.toISOString()}.`);
    }

    const entryPremium = entryCandle.close;
    if (!Number.isFinite(entryPremium) || entryPremium <= 0) {
      throw new Error('Option outcome evaluation requires a positive finite entry premium.');
    }

    const movementByHorizon = new Map<number, OptionPremiumMovementDto | null>(
      horizons.map((horizon) => [horizon, this.getHorizonMovement(sessionCandles, request.signalTimestamp, horizon, entryPremium)])
    );
    const endTimestamp = new Date(request.signalTimestamp.getTime() + 60 * 60_000);
    const futureCandles = sessionCandles.filter(
      (candle) =>
        candle.candleTime.getTime() > request.signalTimestamp.getTime() &&
        candle.candleTime.getTime() <= endTimestamp.getTime()
    );
    const mfe = futureCandles.length > 0
      ? Math.max(...futureCandles.map((candle) => candle.high)) - entryPremium
      : 0;
    const mae = futureCandles.length > 0
      ? entryPremium - Math.min(...futureCandles.map((candle) => candle.low))
      : 0;

    return {
      signalTimestamp: request.signalTimestamp,
      signalType: request.signalType,
      instrumentKey: request.selectedContract.instrumentKey,
      tradingSymbol: request.selectedContract.tradingSymbol,
      optionType: request.selectedContract.optionType,
      strikePrice: request.selectedContract.strikePrice,
      expiry: request.selectedContract.expiry,
      entryPremium,
      at5m: movementByHorizon.get(5) ?? null,
      at15m: movementByHorizon.get(15) ?? null,
      at30m: movementByHorizon.get(30) ?? null,
      at60m: movementByHorizon.get(60) ?? null,
      mfe,
      mfePercent: (mfe / entryPremium) * 100,
      mae,
      maePercent: (mae / entryPremium) * 100,
    };
  }

  private validateRequest(request: OptionOutcomeEvaluationRequest): void {
    if (
      !(request.signalTimestamp instanceof Date) ||
      Number.isNaN(request.signalTimestamp.getTime())
    ) {
      throw new Error('Option outcome evaluation requires a valid signal timestamp.');
    }

    if (
      request.signalType !== StrategySignal.BUY_CE &&
      request.signalType !== StrategySignal.BUY_PE
    ) {
      throw new Error('Option outcome evaluation supports only BUY_CE and BUY_PE signals.');
    }

    request.candles.forEach((candle) => this.validateCandle(candle));
  }

  private validateCandle(candle: ExpiredOptionCandleDto): void {
    if (
      !(candle.candleTime instanceof Date) ||
      Number.isNaN(candle.candleTime.getTime()) ||
      !Number.isFinite(candle.open) ||
      !Number.isFinite(candle.high) ||
      !Number.isFinite(candle.low) ||
      !Number.isFinite(candle.close) ||
      candle.high < candle.low
    ) {
      throw new Error('Option outcome evaluation received an invalid candle.');
    }
  }

  private getHorizonMovement(
    sessionCandles: readonly ExpiredOptionCandleDto[],
    signalTimestamp: Date,
    horizonMinutes: number,
    entryPremium: number
  ): OptionPremiumMovementDto | null {
    const targetTimestamp = signalTimestamp.getTime() + horizonMinutes * 60_000;
    const futureCandle = sessionCandles.find(
      (candle) => candle.candleTime.getTime() === targetTimestamp
    );
    if (!futureCandle) {
      return null;
    }

    const change = futureCandle.close - entryPremium;

    return {
      premium: futureCandle.close,
      change,
      changePercent: (change / entryPremium) * 100,
    };
  }

  private getMarketDate(date: Date): string {
    const values = Object.fromEntries(
      marketDateFormatter.formatToParts(date).map((part) => [part.type, part.value])
    );

    return `${values.year}-${values.month}-${values.day}`;
  }
}
