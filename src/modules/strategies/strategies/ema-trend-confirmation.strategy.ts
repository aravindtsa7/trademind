import { AdxResult } from '../../indicators/indicators/adx.indicator';
import { EmaResult } from '../../indicators/indicators/ema.indicator';
import { RsiResult } from '../../indicators/indicators/rsi.indicator';
import {
  SuperTrendDirection,
  SuperTrendResult,
} from '../../indicators/indicators/supertrend.indicator';
import { StrategySignal, StrategySignalDto } from '../dto/strategy-signal.dto';
import { Strategy } from '../interfaces/strategy.interface';

export interface EmaTrendConfirmationInput {
  previousEma20: EmaResult['values'][number];
  latestEma20: EmaResult['values'][number];
  previousEma50: EmaResult['values'][number];
  latestEma50: EmaResult['values'][number];
  latestRsi14: RsiResult['values'][number];
  latestAdx14: AdxResult['values'][number];
  latestSuperTrend: SuperTrendResult['values'][number];
}

type CrossoverDirection = 'BULLISH' | 'BEARISH';

interface Confirmation {
  passed: boolean;
  confidence: number;
  passedReason: string;
  failedReason: string;
}

export default class EmaTrendConfirmationStrategy
  implements Strategy<EmaTrendConfirmationInput>
{
  readonly id = 'ema-trend-confirmation';

  evaluate(input: EmaTrendConfirmationInput): StrategySignalDto {
    this.validateInput(input);

    const crossover = this.getCrossoverDirection(input);
    if (!crossover) {
      return {
        signal: StrategySignal.NO_TRADE,
        confidence: 0,
        reasons: [
          `No EMA crossover: EMA20 is ${this.describeRelationship(
            input.latestEma20.value,
            input.latestEma50.value
          )} EMA50.`,
        ],
      };
    }

    const confirmations = this.getConfirmations(input, crossover);
    const confidence = 30 + confirmations.reduce(
      (total, confirmation) => total + (confirmation.passed ? confirmation.confidence : 0),
      0
    );
    const crossoverReason =
      crossover === 'BULLISH'
        ? 'EMA20 crossed above EMA50.'
        : 'EMA20 crossed below EMA50.';
    const failedConfirmations = confirmations.filter((confirmation) => !confirmation.passed);

    if (failedConfirmations.length > 0) {
      return {
        signal: StrategySignal.NO_TRADE,
        confidence,
        reasons: [crossoverReason, ...failedConfirmations.map((confirmation) => confirmation.failedReason)],
      };
    }

    return {
      signal: crossover === 'BULLISH' ? StrategySignal.BUY_CE : StrategySignal.BUY_PE,
      confidence,
      reasons: [crossoverReason, ...confirmations.map((confirmation) => confirmation.passedReason)],
    };
  }

  private getCrossoverDirection(input: EmaTrendConfirmationInput): CrossoverDirection | undefined {
    if (
      input.previousEma20.value <= input.previousEma50.value &&
      input.latestEma20.value > input.latestEma50.value
    ) {
      return 'BULLISH';
    }

    if (
      input.previousEma20.value >= input.previousEma50.value &&
      input.latestEma20.value < input.latestEma50.value
    ) {
      return 'BEARISH';
    }

    return undefined;
  }

  private getConfirmations(
    input: EmaTrendConfirmationInput,
    crossover: CrossoverDirection
  ): Confirmation[] {
    const bullish = crossover === 'BULLISH';
    const expectedTrend = bullish ? SuperTrendDirection.UP : SuperTrendDirection.DOWN;
    const directionalIndexPassed = bullish
      ? input.latestAdx14.plusDI > input.latestAdx14.minusDI
      : input.latestAdx14.minusDI > input.latestAdx14.plusDI;
    const rsiPassed = bullish ? input.latestRsi14.value >= 50 : input.latestRsi14.value <= 50;
    const directionalLabel = bullish ? '+DI' : '-DI';
    const oppositeDirectionalLabel = bullish ? '-DI' : '+DI';
    const directionalValue = bullish ? input.latestAdx14.plusDI : input.latestAdx14.minusDI;
    const oppositeDirectionalValue = bullish ? input.latestAdx14.minusDI : input.latestAdx14.plusDI;

    return [
      {
        passed: input.latestAdx14.adx >= 20,
        confidence: 20,
        passedReason: `ADX ${input.latestAdx14.adx} confirms trend strength (>= 20).`,
        failedReason: `ADX ${input.latestAdx14.adx} is below required 20.`,
      },
      {
        passed: directionalIndexPassed,
        confidence: 15,
        passedReason: `${directionalLabel} ${directionalValue} confirms the ${
          bullish ? 'bullish' : 'bearish'
        } direction over ${oppositeDirectionalLabel} ${oppositeDirectionalValue}.`,
        failedReason: `${directionalLabel} ${directionalValue} does not exceed ${oppositeDirectionalLabel} ${oppositeDirectionalValue}.`,
      },
      {
        passed: input.latestSuperTrend.trend === expectedTrend,
        confidence: 20,
        passedReason: `SuperTrend direction ${expectedTrend} confirms the ${
          bullish ? 'bullish' : 'bearish'
        } direction.`,
        failedReason: `SuperTrend direction is ${input.latestSuperTrend.trend}, expected ${expectedTrend}.`,
      },
      {
        passed: rsiPassed,
        confidence: 15,
        passedReason: `RSI ${input.latestRsi14.value} confirms the ${
          bullish ? 'bullish' : 'bearish'
        } threshold.`,
        failedReason: `RSI ${input.latestRsi14.value} does not meet the required ${
          bullish ? '>= 50' : '<= 50'
        } threshold.`,
      },
    ];
  }

  private validateInput(input: EmaTrendConfirmationInput): void {
    const currentTimestamp = input.latestEma20.timestamp;
    const previousTimestamp = input.previousEma20.timestamp;
    const values = [
      input.previousEma20.value,
      input.latestEma20.value,
      input.previousEma50.value,
      input.latestEma50.value,
      input.latestRsi14.value,
      input.latestAdx14.adx,
      input.latestAdx14.plusDI,
      input.latestAdx14.minusDI,
      input.latestSuperTrend.supertrend,
    ];

    if (
      !this.isValidTimestamp(previousTimestamp) ||
      !this.isValidTimestamp(currentTimestamp) ||
      currentTimestamp.getTime() <= previousTimestamp.getTime() ||
      input.previousEma50.timestamp.getTime() !== previousTimestamp.getTime() ||
      input.latestEma50.timestamp.getTime() !== currentTimestamp.getTime() ||
      input.latestRsi14.timestamp.getTime() !== currentTimestamp.getTime() ||
      input.latestAdx14.timestamp.getTime() !== currentTimestamp.getTime() ||
      input.latestSuperTrend.timestamp.getTime() !== currentTimestamp.getTime() ||
      values.some((value) => !Number.isFinite(value))
    ) {
      throw new Error('EMA Trend Confirmation received invalid or misaligned indicator results.');
    }
  }

  private isValidTimestamp(timestamp: Date): boolean {
    return timestamp instanceof Date && !Number.isNaN(timestamp.getTime());
  }

  private describeRelationship(left: number, right: number): string {
    if (left > right) {
      return 'above';
    }

    if (left < right) {
      return 'below';
    }

    return 'equal to';
  }
}
