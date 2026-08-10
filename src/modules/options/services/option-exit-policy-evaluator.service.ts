import { ExpiredOptionCandleDto } from '../dto/upstox-expired-option-candle.dto';
import {
  FixedTimeOptionExitPolicy,
  OptionExitPolicyEvaluationRequest,
  OptionExitPolicyEvaluationResult,
  TargetStopOptionExitPolicy,
} from '../dto/option-exit-policy.dto';

const marketDateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Kolkata',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

export default class OptionExitPolicyEvaluatorService {
  evaluate(request: OptionExitPolicyEvaluationRequest): OptionExitPolicyEvaluationResult {
    this.validateRequest(request);

    const sessionCandles = request.candles
      .filter((candle) => this.getMarketDate(candle.candleTime) === this.getMarketDate(request.signalTimestamp))
      .sort((left, right) => left.candleTime.getTime() - right.candleTime.getTime());

    return request.exitPolicy.type === 'FIXED_TIME'
      ? this.evaluateFixedTime(request, sessionCandles, request.exitPolicy)
      : this.evaluateTargetStop(request, sessionCandles, request.exitPolicy);
  }

  private evaluateFixedTime(
    request: OptionExitPolicyEvaluationRequest,
    sessionCandles: readonly ExpiredOptionCandleDto[],
    policy: FixedTimeOptionExitPolicy
  ): OptionExitPolicyEvaluationResult {
    const targetTimestamp = new Date(
      request.signalTimestamp.getTime() + policy.holdingMinutes * 60_000
    );
    const exitCandle = sessionCandles.find(
      (candle) => candle.candleTime.getTime() === targetTimestamp.getTime()
    );

    return exitCandle
      ? this.createExitResult(request, exitCandle.candleTime, exitCandle.close, 'TIME_EXIT')
      : this.createUnavailableResult(request);
  }

  private evaluateTargetStop(
    request: OptionExitPolicyEvaluationRequest,
    sessionCandles: readonly ExpiredOptionCandleDto[],
    policy: TargetStopOptionExitPolicy
  ): OptionExitPolicyEvaluationResult {
    const targetPremium = request.entryPremium * (1 + policy.targetPercent / 100);
    const stopPremium = request.entryPremium * (1 - policy.stopLossPercent / 100);
    const maximumTimestamp = request.signalTimestamp.getTime() + policy.maximumHoldingMinutes * 60_000;
    const futureCandles = sessionCandles.filter(
      (candle) =>
        candle.candleTime.getTime() > request.signalTimestamp.getTime() &&
        candle.candleTime.getTime() <= maximumTimestamp
    );

    for (const candle of futureCandles) {
      const targetHit = candle.high >= targetPremium;
      const stopHit = candle.low <= stopPremium;

      if (targetHit && stopHit) {
        return {
          ...this.createUnavailableResult(request, targetPremium, stopPremium),
          exitTimestamp: candle.candleTime,
          exitReason: 'AMBIGUOUS',
          holdingMinutes: this.getHoldingMinutes(request.signalTimestamp, candle.candleTime),
          ambiguous: true,
          unavailable: false,
        };
      }

      if (targetHit) {
        return this.createExitResult(request, candle.candleTime, targetPremium, 'TARGET', targetPremium, stopPremium);
      }

      if (stopHit) {
        return this.createExitResult(request, candle.candleTime, stopPremium, 'STOP_LOSS', targetPremium, stopPremium);
      }
    }

    const timeExitCandle = sessionCandles.find(
      (candle) => candle.candleTime.getTime() === maximumTimestamp
    );

    return timeExitCandle
      ? this.createExitResult(
          request,
          timeExitCandle.candleTime,
          timeExitCandle.close,
          'TIME_EXIT',
          targetPremium,
          stopPremium
        )
      : this.createUnavailableResult(request, targetPremium, stopPremium);
  }

  private createExitResult(
    request: OptionExitPolicyEvaluationRequest,
    exitTimestamp: Date,
    exitPremium: number,
    exitReason: OptionExitPolicyEvaluationResult['exitReason'],
    targetPremium?: number,
    stopPremium?: number
  ): OptionExitPolicyEvaluationResult {
    const premiumChange = exitPremium - request.entryPremium;

    return {
      signalTimestamp: request.signalTimestamp,
      entryPremium: request.entryPremium,
      exitTimestamp,
      exitPremium,
      exitReason,
      holdingMinutes: this.getHoldingMinutes(request.signalTimestamp, exitTimestamp),
      premiumChange,
      premiumChangePercent: (premiumChange / request.entryPremium) * 100,
      targetPremium,
      stopPremium,
      ambiguous: false,
      unavailable: false,
    };
  }

  private createUnavailableResult(
    request: OptionExitPolicyEvaluationRequest,
    targetPremium?: number,
    stopPremium?: number
  ): OptionExitPolicyEvaluationResult {
    return {
      signalTimestamp: request.signalTimestamp,
      entryPremium: request.entryPremium,
      exitTimestamp: null,
      exitPremium: null,
      exitReason: 'UNAVAILABLE',
      holdingMinutes: null,
      premiumChange: null,
      premiumChangePercent: null,
      targetPremium,
      stopPremium,
      ambiguous: false,
      unavailable: true,
    };
  }

  private validateRequest(request: OptionExitPolicyEvaluationRequest): void {
    if (!(request.signalTimestamp instanceof Date) || Number.isNaN(request.signalTimestamp.getTime())) {
      throw new Error('Option exit policy evaluation requires a valid signal timestamp.');
    }

    if (!Number.isFinite(request.entryPremium) || request.entryPremium <= 0) {
      throw new Error('Option exit policy evaluation requires a positive finite entry premium.');
    }

    if (request.exitPolicy.type === 'FIXED_TIME') {
      if (![5, 15, 30, 60].includes(request.exitPolicy.holdingMinutes)) {
        throw new Error('Fixed-time option exit holdingMinutes must be 5, 15, 30, or 60.');
      }
    } else if (
      !Number.isFinite(request.exitPolicy.targetPercent) ||
      request.exitPolicy.targetPercent <= 0 ||
      !Number.isFinite(request.exitPolicy.stopLossPercent) ||
      request.exitPolicy.stopLossPercent <= 0 ||
      request.exitPolicy.stopLossPercent >= 100 ||
      !Number.isInteger(request.exitPolicy.maximumHoldingMinutes) ||
      request.exitPolicy.maximumHoldingMinutes <= 0
    ) {
      throw new Error('Target-stop option exit policy configuration is invalid.');
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
      throw new Error('Option exit policy evaluation received an invalid candle.');
    }
  }

  private getHoldingMinutes(signalTimestamp: Date, exitTimestamp: Date): number {
    return (exitTimestamp.getTime() - signalTimestamp.getTime()) / 60_000;
  }

  private getMarketDate(date: Date): string {
    const values = Object.fromEntries(
      marketDateFormatter.formatToParts(date).map((part) => [part.type, part.value])
    );

    return `${values.year}-${values.month}-${values.day}`;
  }
}
