import PerformanceAnalyzerService from './performance-analyzer.service';
import {
  DominantSignalDirection,
  StrategyAnalysisInputDto,
  StrategyReportDto,
} from '../dto/strategy-report.dto';

interface PerformanceAnalyzer {
  analyze: PerformanceAnalyzerService['analyze'];
}

export default class StrategyAnalyzerService {
  constructor(
    private readonly performanceAnalyzer: PerformanceAnalyzer = new PerformanceAnalyzerService(),
    private readonly now: () => Date = () => new Date()
  ) {}

  analyze(input: StrategyAnalysisInputDto): StrategyReportDto {
    const performanceMetrics = this.performanceAnalyzer.analyze(input.signalResults);

    return {
      strategyId: input.strategyId,
      strategyName: input.strategyName,
      instrumentKey: input.instrumentKey,
      timeframe: input.timeframe,
      fromDate: input.fromDate,
      toDate: input.toDate,
      performanceMetrics,
      signalFrequencyPerSession: this.calculateSignalFrequency(
        performanceMetrics.totalSignals,
        input.sessionCount
      ),
      dominantSignalDirection: this.getDominantSignalDirection(
        performanceMetrics.buyCeSignals,
        performanceMetrics.buyPeSignals
      ),
      generatedAt: this.now(),
    };
  }

  private calculateSignalFrequency(
    totalSignals: number,
    sessionCount: number | undefined
  ): number | undefined {
    return sessionCount !== undefined && Number.isFinite(sessionCount) && sessionCount > 0
      ? totalSignals / sessionCount
      : undefined;
  }

  private getDominantSignalDirection(
    buyCeSignals: number,
    buyPeSignals: number
  ): DominantSignalDirection {
    if (buyCeSignals === 0 && buyPeSignals === 0) {
      return 'NONE';
    }

    if (buyCeSignals === buyPeSignals) {
      return 'BALANCED';
    }

    return buyCeSignals > buyPeSignals ? 'BUY_CE' : 'BUY_PE';
  }
}
