import {
  PerformanceMetricsDto,
  SignalPerformanceResultDto,
} from '../dto/performance-metrics.dto';

const horizons = ['5m', '15m', '30m', '60m'] as const;

type Horizon = (typeof horizons)[number];

export default class PerformanceAnalyzerService {
  analyze(signalResults: readonly SignalPerformanceResultDto[]): PerformanceMetricsDto {
    const directionalValues = Object.fromEntries(
      horizons.map((horizon) => [
        horizon,
        signalResults
          .map((result) => result.directionalPoints[horizon])
          .filter((value): value is number => value !== null),
      ])
    ) as Record<Horizon, number[]>;

    return {
      totalSignals: signalResults.length,
      evaluableSignals: directionalValues['60m'].length,
      buyCeSignals: signalResults.filter((result) => result.signal === 'BUY_CE').length,
      buyPeSignals: signalResults.filter((result) => result.signal === 'BUY_PE').length,
      correct5m: this.countPositive(directionalValues['5m']),
      correct15m: this.countPositive(directionalValues['15m']),
      correct30m: this.countPositive(directionalValues['30m']),
      correct60m: this.countPositive(directionalValues['60m']),
      accuracy5m: this.calculateAccuracy(directionalValues['5m']),
      accuracy15m: this.calculateAccuracy(directionalValues['15m']),
      accuracy30m: this.calculateAccuracy(directionalValues['30m']),
      accuracy60m: this.calculateAccuracy(directionalValues['60m']),
      avg5m: this.calculateAverage(directionalValues['5m']),
      avg15m: this.calculateAverage(directionalValues['15m']),
      avg30m: this.calculateAverage(directionalValues['30m']),
      avg60m: this.calculateAverage(directionalValues['60m']),
      avgMFE: this.calculateAverage(this.getAvailableValues(signalResults, 'mfe')),
      avgMAE: this.calculateAverage(this.getAvailableValues(signalResults, 'mae')),
    };
  }

  private getAvailableValues(
    signalResults: readonly SignalPerformanceResultDto[],
    key: 'mfe' | 'mae'
  ): number[] {
    return signalResults
      .map((result) => result[key])
      .filter((value): value is number => value !== null);
  }

  private countPositive(values: readonly number[]): number {
    return values.filter((value) => value > 0).length;
  }

  private calculateAccuracy(values: readonly number[]): number {
    if (values.length === 0) {
      return 0;
    }

    return (this.countPositive(values) / values.length) * 100;
  }

  private calculateAverage(values: readonly number[]): number {
    if (values.length === 0) {
      return 0;
    }

    return values.reduce((total, value) => total + value, 0) / values.length;
  }
}
