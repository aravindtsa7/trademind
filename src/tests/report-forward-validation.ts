import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { ForwardJournalRecord } from '../modules/research-validation';

const root = resolve(process.cwd(), 'artifacts', 'forward-validation');
const output = resolve(root, 'forward-validation-summary.json');
const summary = { generatedAt: new Date().toISOString(), networkRequests: 0, V2: summarize('V2_TREND_DOWN_PE'), V4: summarize('V4_NIFTY_MOMENTUM_PE_SHADOW') };
mkdirSync(root, { recursive: true });
writeFileSync(output, `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));

function summarize(strategyId: string) {
  const records = load(strategyId);
  const sessions = records.filter((record) => record.recordType === 'SESSION');
  const signals = records.filter((record) => record.recordType === 'SIGNAL');
  const exits = records.filter((record) => record.recordType === 'EXIT');
  const frictions = exits.map((record) => record.totalExecutionFrictionPercent).filter((value): value is number => value !== undefined && Number.isFinite(value));
  const executable = exits.map((record) => record.executableEstimatedReturn).filter((value): value is number => value !== undefined && value !== null && Number.isFinite(value));
  const theoretical = exits.map((record) => record.theoreticalReturn).filter((value): value is number => value !== undefined && value !== null && Number.isFinite(value));
  const byDate = new Map<string, number>();
  exits.forEach((record) => byDate.set(record.tradingDate, (byDate.get(record.tradingDate) ?? 0) + (record.executableEstimatedReturn ?? 0)));
  return { strategyId, sessionsObserved: sessions.length, signals: signals.length, resolvedTrades: exits.filter((record) => record.executableEstimatedReturn !== null && record.executableEstimatedReturn !== undefined).length, unresolvedTrades: exits.filter((record) => record.executableEstimatedReturn === null || record.executableEstimatedReturn === undefined).length, theoreticalExpectancy: average(theoretical), executableEstimatedExpectancy: average(executable), spreadSlippageAverage: average(frictions), spreadSlippageMedian: median(frictions), spreadSlippageP90: percentile(frictions, .9), bidAskCoveragePct: quoteCoverage(exits), staleQuotePct: staleRate(exits), targetRate: rate(exits, ['TARGET']), stopRate: rate(exits, ['STOP']), timeoutRate: rate(exits, ['TIMEOUT']), eodRate: rate(exits, ['EOD']), profitableDayPct: [...byDate.values()].length ? [...byDate.values()].filter((value) => value > 0).length / byDate.size * 100 : 0, maxDrawdown: maxDrawdown([...byDate.values()]), maxLossStreak: streak([...byDate.values()].map((value) => value < 0)), costStress: Object.fromEntries([.2, .4, .6, .8, 1].map((cost) => [`netAt${String(cost).replace('.', '')}`, average(theoretical) - cost])), dataQualityFlags: [...new Set(records.flatMap((record) => record.flags ?? []))], timeOfDayFriction: bucket(exits, timeBucket), premiumBucketFriction: bucket(exits, premiumBucket), promotionDiagnostic: promotion(records, exits) };
}
function load(strategyId: string): ForwardJournalRecord[] { const directory = resolve(root, strategyId); if (!existsSync(directory)) return []; return readdirSync(directory).filter((file) => file.endsWith('.jsonl')).flatMap((file) => readFileSync(resolve(directory, file), 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as ForwardJournalRecord)); }
function average(values: readonly number[]) { return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0; }
function median(values: readonly number[]) { if (!values.length) return 0; const sorted = [...values].sort((a, b) => a - b); const middle = Math.floor(sorted.length / 2); return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2; }
function percentile(values: readonly number[], p: number) { if (!values.length) return 0; const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))]; }
function rate(records: readonly ForwardJournalRecord[], reasons: readonly string[]) { return records.length ? records.filter((record) => reasons.includes(record.exitReason ?? '')).length / records.length * 100 : 0; }
function quoteCoverage(records: readonly ForwardJournalRecord[]) { return records.length ? records.filter((record) => record.executionQuoteQuality === 'BID_ASK').length / records.length * 100 : 0; }
function staleRate(records: readonly ForwardJournalRecord[]) { return records.length ? records.filter((record) => record.executionQuoteQuality === 'STALE_QUOTE' || (record.flags ?? []).includes('STALE_OPTION_QUOTE')).length / records.length * 100 : 0; }
function maxDrawdown(values: readonly number[]) { let equity = 0; let peak = 0; let drawdown = 0; values.forEach((value) => { equity += value; peak = Math.max(peak, equity); drawdown = Math.max(drawdown, peak - equity); }); return drawdown; }
function streak(values: readonly boolean[]) { let current = 0; let best = 0; values.forEach((value) => { current = value ? current + 1 : 0; best = Math.max(best, current); }); return best; }
function timeBucket(record: ForwardJournalRecord) { const hour = record.signalTimestampIst ? Number(record.signalTimestampIst.slice(11, 13)) * 60 + Number(record.signalTimestampIst.slice(14, 16)) : -1; return hour < 570 ? '09:15-09:30' : hour < 630 ? '09:30-10:30' : hour < 720 ? '10:30-12:00' : hour < 840 ? '12:00-14:00' : hour < 900 ? '14:00-15:00' : '15:00-15:30'; }
function premiumBucket(record: ForwardJournalRecord) { const value = record.theoreticalEntryPrice ?? -1; return value < 50 ? '<50' : value < 75 ? '50-75' : value < 100 ? '75-100' : value < 125 ? '100-125' : value <= 200 ? '125-200' : '>200'; }
function bucket(records: readonly ForwardJournalRecord[], selector: (record: ForwardJournalRecord) => string) { const groups = new Map<string, number[]>(); records.forEach((record) => { const value = record.totalExecutionFrictionPercent; if (value === undefined || value === null) return; groups.set(selector(record), [...(groups.get(selector(record)) ?? []), value]); }); return Object.fromEntries([...groups.entries()].map(([key, values]) => [key, { count: values.length, average: average(values), median: median(values), p90: percentile(values, .9) }])); }
function promotion(records: readonly ForwardJournalRecord[], exits: readonly ForwardJournalRecord[]) { const sessions = new Set(exits.map((record) => record.tradingDate)).size; const resolved = exits.filter((record) => record.executableEstimatedReturn !== null && record.executableEstimatedReturn !== undefined).length; if (resolved === 0) return 'NOT_ENOUGH_FORWARD_DATA'; return resolved >= 30 && sessions >= 20 ? 'ELIGIBLE_FOR_MANUAL_REVIEW' : 'CONTINUE_FORWARD_VALIDATION'; }
