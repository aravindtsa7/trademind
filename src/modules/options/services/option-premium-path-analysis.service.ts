import { ExpiredOptionCandleDto } from '../dto/upstox-expired-option-candle.dto';
import { OptionExitPolicyEvaluationResult, TargetStopOptionExitPolicy } from '../dto/option-exit-policy.dto';

export interface OptionPremiumPathResearchRequest { changeHorizons: readonly number[]; excursionHorizons: readonly number[]; upsideTargets: readonly number[]; downsideStops: readonly number[]; }
export interface OptionPremiumPathResearchAnalytics { entryPremium: number; changes: ReadonlyMap<number, number | null>; excursions: ReadonlyMap<number, { mfe: number | null; mae: number | null }>; reaches: ReadonlyMap<number, number | null>; }

export default class OptionPremiumPathAnalysisService {
  private readonly byOffset = new Map<number, ExpiredOptionCandleDto>();
  readonly entryPremium: number;

  constructor(private readonly signalTimestamp: Date, candles: readonly ExpiredOptionCandleDto[]) {
    candles.forEach((candle) => { const offset = (candle.candleTime.getTime() - signalTimestamp.getTime()) / 60_000; if (Number.isInteger(offset) && offset >= 0) this.byOffset.set(offset, candle); });
    const entry = this.byOffset.get(0);
    if (!entry) throw new Error(`Option path analysis cannot find a candle at ${signalTimestamp.toISOString()}.`);
    if (!Number.isFinite(entry.close) || entry.close <= 0) throw new Error('Option path analysis requires a positive finite entry premium.');
    this.entryPremium = entry.close;
  }

  candleAt(offset: number): ExpiredOptionCandleDto | undefined { return this.byOffset.get(offset); }

  researchAnalytics(request: OptionPremiumPathResearchRequest): OptionPremiumPathResearchAnalytics {
    const changes = new Map<number, number | null>(); const excursions = new Map<number, { mfe: number | null; mae: number | null }>(); const reaches = new Map<number, number | null>();
    const changeHorizons = new Set(request.changeHorizons); const excursionHorizons = new Set(request.excursionHorizons); const upside = request.upsideTargets.map((percent) => ({ percent, premium: this.entryPremium * (1 + percent / 100) })); const downside = request.downsideStops.map((percent) => ({ percent, premium: this.entryPremium * (1 - percent / 100) }));
    const maxHorizon = Math.max(0, ...request.changeHorizons, ...request.excursionHorizons); const maxOffset = Math.max(maxHorizon, ...this.byOffset.keys()); let continuous = true; let runningHigh = -Infinity; let runningLow = Infinity;
    for (let offset = 1; offset <= maxOffset; offset += 1) {
      const candle = this.byOffset.get(offset);
      if (!candle) continuous = false;
      if (changeHorizons.has(offset)) changes.set(offset, candle === undefined ? null : (candle.close - this.entryPremium) / this.entryPremium * 100);
      if (!candle) { if (excursionHorizons.has(offset)) excursions.set(offset, { mfe: null, mae: null }); continue; }
      runningHigh = Math.max(runningHigh, candle.high); runningLow = Math.min(runningLow, candle.low);
      upside.forEach((target) => { if (!reaches.has(target.percent) && candle.high >= target.premium) reaches.set(target.percent, offset); });
      downside.forEach((stop) => { const key = -stop.percent; if (!reaches.has(key) && candle.low <= stop.premium) reaches.set(key, offset); });
      if (excursionHorizons.has(offset)) excursions.set(offset, continuous ? { mfe: (runningHigh - this.entryPremium) / this.entryPremium * 100, mae: (this.entryPremium - runningLow) / this.entryPremium * 100 } : { mfe: null, mae: null });
    }
    request.changeHorizons.forEach((horizon) => { if (!changes.has(horizon)) changes.set(horizon, null); }); request.excursionHorizons.forEach((horizon) => { if (!excursions.has(horizon)) excursions.set(horizon, { mfe: null, mae: null }); }); request.upsideTargets.forEach((target) => { if (!reaches.has(target)) reaches.set(target, null); }); request.downsideStops.forEach((stop) => { if (!reaches.has(-stop)) reaches.set(-stop, null); });
    return { entryPremium: this.entryPremium, changes, excursions, reaches };
  }

  evaluate(policy: TargetStopOptionExitPolicy): OptionExitPolicyEvaluationResult { const targetPremium = this.entryPremium * (1 + policy.targetPercent / 100); const stopPremium = this.entryPremium * (1 - policy.stopLossPercent / 100); for (let offset = 1; offset <= policy.maximumHoldingMinutes; offset += 1) { const candle = this.byOffset.get(offset); if (!candle) continue; const target = candle.high >= targetPremium; const stop = candle.low <= stopPremium; if (target && stop) return this.ambiguous(candle, targetPremium, stopPremium); if (target) return this.result(candle, targetPremium, 'TARGET', targetPremium, stopPremium); if (stop) return this.result(candle, stopPremium, 'STOP_LOSS', targetPremium, stopPremium); } const time = this.byOffset.get(policy.maximumHoldingMinutes); return time ? this.result(time, time.close, 'TIME_EXIT', targetPremium, stopPremium) : this.unavailable(targetPremium, stopPremium); }

  private result(candle: ExpiredOptionCandleDto, premium: number, reason: 'TARGET' | 'STOP_LOSS' | 'TIME_EXIT', targetPremium: number, stopPremium: number): OptionExitPolicyEvaluationResult { const change = premium - this.entryPremium; return { signalTimestamp: this.signalTimestamp, entryPremium: this.entryPremium, exitTimestamp: new Date(candle.candleTime.getTime()), exitPremium: premium, exitReason: reason, holdingMinutes: (candle.candleTime.getTime() - this.signalTimestamp.getTime()) / 60_000, premiumChange: change, premiumChangePercent: change / this.entryPremium * 100, targetPremium, stopPremium, ambiguous: false, unavailable: false }; }
  private ambiguous(candle: ExpiredOptionCandleDto, targetPremium: number, stopPremium: number): OptionExitPolicyEvaluationResult { return { ...this.unavailable(targetPremium, stopPremium), exitTimestamp: new Date(candle.candleTime.getTime()), exitReason: 'AMBIGUOUS', holdingMinutes: (candle.candleTime.getTime() - this.signalTimestamp.getTime()) / 60_000, ambiguous: true, unavailable: false }; }
  private unavailable(targetPremium: number, stopPremium: number): OptionExitPolicyEvaluationResult { return { signalTimestamp: this.signalTimestamp, entryPremium: this.entryPremium, exitTimestamp: null, exitPremium: null, exitReason: 'UNAVAILABLE', holdingMinutes: null, premiumChange: null, premiumChangePercent: null, targetPremium, stopPremium, ambiguous: false, unavailable: true }; }
}
