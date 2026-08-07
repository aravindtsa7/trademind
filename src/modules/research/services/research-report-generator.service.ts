import { RegimePerformanceDto } from '../dto/regime-strategy-report.dto';
import {
  ResearchReportDto,
  ResearchReportInput,
  ResearchReportSectionDto,
} from '../dto/research-report.dto';
import { ResearchRunResult } from '../dto/research-run.dto';

export default class ResearchReportGeneratorService {
  generate(input: ResearchReportInput): ResearchReportDto {
    const runs = Array.isArray(input) ? input : [input];
    if (runs.length === 0) {
      throw new Error('Research Report Generator requires at least one research run.');
    }

    const sections = runs.flatMap((run) => this.createRunSections(run));
    if (runs.length > 1) {
      sections.push(this.createComparisonSection(runs));
    }

    return {
      sections,
      text: this.formatSections(sections),
    };
  }

  private createRunSections(run: ResearchRunResult): ResearchReportSectionDto[] {
    const metrics = run.strategyReport.performanceMetrics;
    const regimeReport = run.regimeStrategyReport;

    return [
      {
        type: 'METADATA',
        title: `${run.strategyName} — Metadata`,
        lines: [
          `Strategy: ${run.strategyName} (${run.strategyId})`,
          `Instrument: ${run.instrumentKey}`,
          `Timeframe: ${run.timeframe}`,
          `Date range: ${run.fromDate} to ${run.toDate}`,
          `Session count: ${run.sessionCount}`,
          `Candle count: ${run.candleCount}`,
          `Generated at: ${run.generatedAt.toISOString()}`,
        ],
      },
      {
        type: 'SIGNAL_SUMMARY',
        title: `${run.strategyName} — Signal Summary`,
        lines: [
          `Emitted signals: ${run.emittedSignals}`,
          `Evaluable signals: ${metrics.evaluableSignals}`,
          `BUY_CE count: ${metrics.buyCeSignals}`,
          `BUY_PE count: ${metrics.buyPeSignals}`,
          `Signal frequency per session: ${this.formatNumber(
            run.strategyReport.signalFrequencyPerSession
          )}`,
        ],
      },
      {
        type: 'PERFORMANCE',
        title: `${run.strategyName} — Performance`,
        lines: [
          `Accuracy 5m: ${this.formatPercentage(metrics.accuracy5m)}`,
          `Accuracy 15m: ${this.formatPercentage(metrics.accuracy15m)}`,
          `Accuracy 30m: ${this.formatPercentage(metrics.accuracy30m)}`,
          `Accuracy 60m: ${this.formatPercentage(metrics.accuracy60m)}`,
          `Average 5m movement: ${this.formatNumber(metrics.avg5m)}`,
          `Average 15m movement: ${this.formatNumber(metrics.avg15m)}`,
          `Average 30m movement: ${this.formatNumber(metrics.avg30m)}`,
          `Average 60m movement: ${this.formatNumber(metrics.avg60m)}`,
          `Average MFE: ${this.formatNumber(metrics.avgMFE)}`,
          `Average MAE: ${this.formatNumber(metrics.avgMAE)}`,
        ],
      },
      {
        type: 'REGIME_ANALYSIS',
        title: `${run.strategyName} — Regime Analysis`,
        lines: [
          `Best directional regime: ${regimeReport.bestDirectionalRegime ?? 'N/A'}`,
          `Worst directional regime: ${regimeReport.worstDirectionalRegime ?? 'N/A'}`,
          `Best volatility regime: ${regimeReport.bestVolatilityRegime ?? 'N/A'}`,
          `Worst volatility regime: ${regimeReport.worstVolatilityRegime ?? 'N/A'}`,
          'Directional-regime breakdown:',
          this.formatRegimeGroup('TREND_UP', regimeReport.directionalRegimePerformance.TREND_UP),
          this.formatRegimeGroup('TREND_DOWN', regimeReport.directionalRegimePerformance.TREND_DOWN),
          this.formatRegimeGroup('SIDEWAYS', regimeReport.directionalRegimePerformance.SIDEWAYS),
          'Volatility-regime breakdown:',
          this.formatRegimeGroup(
            'HIGH_VOLATILITY',
            regimeReport.volatilityRegimePerformance.HIGH_VOLATILITY
          ),
          this.formatRegimeGroup(
            'NORMAL_VOLATILITY',
            regimeReport.volatilityRegimePerformance.NORMAL_VOLATILITY
          ),
          this.formatRegimeGroup(
            'LOW_VOLATILITY',
            regimeReport.volatilityRegimePerformance.LOW_VOLATILITY
          ),
        ],
      },
    ];
  }

  private createComparisonSection(runs: readonly ResearchRunResult[]): ResearchReportSectionDto {
    return {
      type: 'COMPARISON_SUMMARY',
      title: 'Research Run Comparison Summary',
      lines: [
        'Strategy | Signals | Accuracy 5m | Accuracy 15m | Accuracy 30m | Accuracy 60m | Avg 5m | Avg 15m | Avg 30m | Avg 60m | Avg MFE | Avg MAE',
        ...runs.map((run) => {
          const metrics = run.strategyReport.performanceMetrics;

          return [
            run.strategyName,
            run.emittedSignals,
            this.formatPercentage(metrics.accuracy5m),
            this.formatPercentage(metrics.accuracy15m),
            this.formatPercentage(metrics.accuracy30m),
            this.formatPercentage(metrics.accuracy60m),
            this.formatNumber(metrics.avg5m),
            this.formatNumber(metrics.avg15m),
            this.formatNumber(metrics.avg30m),
            this.formatNumber(metrics.avg60m),
            this.formatNumber(metrics.avgMFE),
            this.formatNumber(metrics.avgMAE),
          ].join(' | ');
        }),
      ],
    };
  }

  private formatRegimeGroup(label: string, group: RegimePerformanceDto<string>): string {
    const metrics = group.performanceMetrics;

    return `${label}: signals=${group.signalCount}, evaluable=${group.evaluableSignalCount}, accuracy60m=${this.formatPercentage(
      metrics.accuracy60m
    )}, avg60m=${this.formatNumber(metrics.avg60m)}, avgMFE=${this.formatNumber(
      metrics.avgMFE
    )}, avgMAE=${this.formatNumber(metrics.avgMAE)}`;
  }

  private formatSections(sections: readonly ResearchReportSectionDto[]): string {
    return sections
      .map((section) => `[${section.title}]\n${section.lines.join('\n')}`)
      .join('\n\n');
  }

  private formatPercentage(value: number | null | undefined): string {
    const formattedNumber = this.formatNumber(value);

    return formattedNumber === 'N/A' ? formattedNumber : `${formattedNumber}%`;
  }

  private formatNumber(value: number | null | undefined): string {
    return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(2) : 'N/A';
  }
}
