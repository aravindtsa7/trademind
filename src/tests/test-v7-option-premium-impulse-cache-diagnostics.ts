import dotenv from 'dotenv';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import logger from '../core/logger/logger';
import HistoricalCandleRepository from '../modules/historical-candles/repositories/historical-candle.repository';
import CandleTimeframeAggregatorService from '../modules/indicators/services/candle-timeframe-aggregator.service';
import IndicatorEngineService from '../modules/indicators/services/indicator-engine.service';
import { Candle } from '../modules/indicators/types';
import AdaptiveMarketRegimeService from '../modules/adaptive-intraday/services/adaptive-market-regime.service';
import UpstoxExpiredOptionCandleClient from '../modules/options/client/upstox-expired-option-candle.client';
import UpstoxExpiredOptionClient from '../modules/options/client/upstox-expired-option.client';
import HistoricalOptionCandleRepository from '../modules/options/repositories/historical-option-candle.repository';
import HistoricalOptionCandleCacheService from '../modules/options/services/historical-option-candle-cache.service';
import HistoricalOptionResearchPreloaderService from '../modules/options/services/historical-option-research-preloader.service';
import OptionContractSelectorService from '../modules/options/services/option-contract-selector.service';
import { OptionContract, OptionContractSelectionResult } from '../modules/options/types';
import { StrategySignal } from '../modules/strategies/dto/strategy-signal.dto';
import { filterCrossSessionResearchTargets, prepareCrossSessionIndicatorWarmup } from './helpers/cross-session-indicator-warmup';
import { chooseHistoricalOptionExpiry, deduplicateDirectionalOptionSessions, DirectionalOptionSessionRequirement } from './helpers/v3-option-cache-diagnostics';
import { assertV7NoLookAhead, buildV7OptionPremiumFeatures, collectV7UnderlyingImpulseCandidates, createV7OptionImpulseConfigs, deduplicateV7Signals, featureKey, generateV7Signals, prepareV7IndicatorContext, v7ConfigKey, v7GridDesign, V7Direction, V7OptionPremiumFeature } from './helpers/v7-option-premium-impulse-signal-generation';

dotenv.config();
logger.silent = true;

const underlyingInstrumentKey = 'NSE_INDEX|Nifty 50';
const endDate = dateInput(process.env.RESEARCH_END_DATE ?? '2026-08-04');
const artifactsDirectory = resolve(process.cwd(), 'artifacts', 'v7-option-impulse');
interface BroadCandidate { direction: V7Direction; date: string; timestamp: Date; spotPrice: number; timeframe: 1 | 2; }
interface Prepared { candidate: BroadCandidate; instrumentKey: string; tradingDate: string; selection: OptionContractSelectionResult; }

async function run(): Promise<void> {
  if (process.env.RESEARCH_LOCAL_ONLY !== 'true') throw new Error('V7 Phase 1 is diagnostics-only and requires RESEARCH_LOCAL_ONLY=true.');
  const token = process.env.UPSTOX_ACCESS_TOKEN?.trim();
  if (!token) throw new Error('Set UPSTOX_ACCESS_TOKEN to resolve authoritative expired NIFTY option metadata.');
  const optionRepository = new HistoricalOptionCandleRepository();
  const cache = new HistoricalOptionCandleCacheService(optionRepository, new UpstoxExpiredOptionCandleClient(token));
  const preloader = new HistoricalOptionResearchPreloaderService(new HistoricalCandleRepository(), optionRepository, cache, true);
  const engine = new IndicatorEngineService();
  const aggregator = new CandleTimeframeAggregatorService();
  const regime = new AdaptiveMarketRegimeService({ trendStrengthThreshold: 20, emaProximityPercent: .05, highVolatilityThreshold: .1, lowVolatilityThreshold: .05 });
  const underlying = await preloader.preloadUnderlying(underlyingInstrumentKey, '1minute');
  const complete = [...underlying.underlyingByDate.entries()].filter(([, rows]) => validSession(rows, undefined).valid).sort(([a], [b]) => a.localeCompare(b));
  const sessions = filterCrossSessionResearchTargets(prepareCrossSessionIndicatorWarmup(complete.map(([date, candles]) => ({ date, candles })), aggregator, engine, regime), endDate);
  if (sessions.length !== 104 || sessions[0]?.date !== '2026-03-02' || sessions.at(-1)?.date !== '2026-08-04') throw new Error(`Expected exactly the validated V7 scope through ${endDate}; got ${sessions.length} sessions.`);
  const configs = createV7OptionImpulseConfigs();
  const indicators = prepareV7IndicatorContext(sessions, engine);
  const broad = collectV7UnderlyingImpulseCandidates(sessions, indicators);
  const candidates = broad.map((value) => ({ ...value }));
  const client = new UpstoxExpiredOptionClient(token); const selector = new OptionContractSelectorService();
  const expiryCache = new Map<string, Promise<string[]>>(); const contractCache = new Map<string, Promise<OptionContract[]>>();
  const prepared = await mapConcurrent(candidates, 3, (candidate) => resolveContract(candidate, client, selector, expiryCache, contractCache));
  const inspection = await preloader.inspectLocalOptionSessions(prepared);
  const inspected = new Map(inspection.sessions.map((value) => [sessionKey(value.instrumentKey, value.tradingDate), value]));
  const requirements: DirectionalOptionSessionRequirement[] = prepared.map((entry) => {
    const local = inspected.get(sessionKey(entry.instrumentKey, entry.tradingDate));
    if (!local) throw new Error(`Missing V7 local inspection for ${entry.instrumentKey} ${entry.tradingDate}.`);
    return { instrumentKey: entry.instrumentKey, tradingDate: entry.tradingDate, direction: entry.candidate.direction, locallyAvailableCandleCount: local.locallyAvailableCandleCount, completenessState: local.complete ? 'COMPLETE' : local.locallyAvailableCandleCount === 0 ? 'MISSING' : 'INCOMPLETE' };
  });
  const global = deduplicateDirectionalOptionSessions(requirements);
  const rawRows = await optionRepository.findByInstrumentDateSessions(global, '1minute');
  const localCandles = new Map<string, Candle[]>(); rawRows.forEach((row) => { const key = sessionKey(row.instrumentKey, istDate(row.candleTime)); localCandles.set(key, [...(localCandles.get(key) ?? []), { timestamp: new Date(row.candleTime.getTime()), open: Number(row.open), high: Number(row.high), low: Number(row.low), close: Number(row.close), volume: Number(row.volume), openInterest: row.openInterest === null ? undefined : Number(row.openInterest) }]); });
  // Empty sessions are missing cache coverage, not malformed/overfull local data.
  // Only rows that actually exist locally are structurally inspected here.
  const anomalies = global.filter((entry) => entry.locallyAvailableCandleCount > 0).flatMap((entry) => { const validation = validSession(localCandles.get(sessionKey(entry.instrumentKey, entry.tradingDate)) ?? [], entry.tradingDate); return validation.valid ? [] : [{ instrumentKey: entry.instrumentKey, tradingDate: entry.tradingDate, directions: entry.directions, rowCount: validation.rowCount, firstTimestampIst: validation.first, lastTimestampIst: validation.last, reasons: validation.reasons }]; });
  const cacheBlocked = global.some((entry) => entry.completenessState !== 'COMPLETE') || anomalies.length > 0;
  let rawSignals: Record<V7Direction, number> = { CE: 0, PE: 0 };
  let uniqueSignals: ReturnType<typeof deduplicateV7Signals> = [];
  let configSummaries: Array<{ configKey: string; direction: V7Direction; signals: number }> = [];
  if (!cacheBlocked) {
    const featureByDirectionTime = buildFeatures(prepared, localCandles, engine);
    // Keep only a count per frozen configuration and a deduplicated timestamp
    // map. Retaining every configuration's full signal list requires multiple
    // gigabytes but contributes nothing additional to Phase 1 diagnostics.
    const uniqueByTimestamp = new Map<string, ReturnType<typeof generateV7Signals>[number]>();
    for (const config of configs) {
      const signals = generateV7Signals(sessions, config, indicators, featureByDirectionTime);
      assertV7NoLookAhead(signals); rawSignals[config.direction] += signals.length;
      configSummaries.push({ configKey: v7ConfigKey(config), direction: config.direction, signals: signals.length });
      signals.forEach((signal) => uniqueByTimestamp.set(`${signal.direction}\u0000${signal.timestamp.getTime()}`, uniqueByTimestamp.get(`${signal.direction}\u0000${signal.timestamp.getTime()}`) ?? signal));
    }
    uniqueSignals = deduplicateV7Signals([...uniqueByTimestamp.values()]);
  }
  const byDirection = (direction: V7Direction) => {
    const rows = deduplicateDirectionalOptionSessions(requirements.filter((item) => item.direction === direction));
    const signals = uniqueSignals.filter((signal) => signal.direction === direction);
    return { rawSignalsAcrossConfigurations: rawSignals[direction], uniqueSignalTimestamps: signals.length, averageUniqueSignalsPerSession: round(signals.length / sessions.length), activeSessions: new Set(signals.map((signal) => signal.date)).size, maximumUniqueSignalsInOneDay: Math.max(0, ...sessions.map((session) => signals.filter((signal) => signal.date === session.date).length)), requiredOptionSessions: rows.length, completeLocalSessions: rows.filter((row) => row.completenessState === 'COMPLETE').length, missingLocalSessions: rows.filter((row) => row.completenessState === 'MISSING').length, incompleteLocalSessions: rows.filter((row) => row.completenessState === 'INCOMPLETE').length };
  };
  const ce = byDirection('CE'), pe = byDirection('PE'); const grid = v7GridDesign();
  const distributions = { CE: distributionsFor(uniqueSignals.filter((value) => value.direction === 'CE')), PE: distributionsFor(uniqueSignals.filter((value) => value.direction === 'PE')) };
  const selectedContracts = prepared.map((entry) => ({ direction: entry.candidate.direction, timestamp: entry.candidate.timestamp.toISOString(), tradingDate: entry.tradingDate, instrumentKey: entry.instrumentKey, tradingSymbol: entry.selection.tradingSymbol, strikePrice: entry.selection.strikePrice, expiry: entry.selection.expiry.toISOString(), source: 'UNDERLYING_IMPULSE_ENVELOPE' }));
  const confirmedSignals = uniqueSignals.map((signal) => ({ configKey: signal.configKey, direction: signal.direction, timestamp: signal.timestamp.toISOString(), tradingDate: signal.date, underlying: { timeframe: signal.configKey.split('|')[1], open: signal.underlyingOpen, high: signal.underlyingHigh, low: signal.underlyingLow, close: signal.underlyingClose, atr14: signal.underlyingAtr14, bodyAtr: signal.underlyingBodyAtr, regime: signal.regime }, optionPremium: { instrumentKey: signal.option.instrumentKey, expiry: selectionFor(signal, prepared)?.selection.expiry.toISOString(), strike: selectionFor(signal, prepared)?.selection.strikePrice, close: signal.option.close, returnPercent: signal.option.returnPercent, atr14: signal.option.atr14, bodyAtr: signal.option.bodyAtr, confirmationAvailableAt: signal.option.availableAt.toISOString() } }));
  const manifest = { schemaVersion: 1, researchVersion: 'V7_NIFTY_OPTION_PREMIUM_IMPULSE_PHASE_1', outcomeResearchRun: false, localOnly: true, underlyingInstrumentKey, targetDateRange: { start: sessions[0].date, end: sessions.at(-1)?.date, targetSessions: sessions.length }, grid, CE: ce, PE: pe, combinedUniqueTimestamps: uniqueSignals.length, signalDiagnosticsAvailable: !cacheBlocked, noLookAhead: cacheBlocked ? 'NOT_EVALUATED_CACHE_INCOMPLETE' : 'PASSED', globalRequiredSessions: global, missingSessions: global.filter((row) => row.completenessState === 'MISSING'), incompleteSessions: global.filter((row) => row.completenessState === 'INCOMPLETE'), malformedOrOverfullSessions: anomalies, selectedContracts, confirmedSignals };
  mkdirSync(artifactsDirectory, { recursive: true });
  write('phase-1-diagnostics-summary.json', { targetDateRange: manifest.targetDateRange, grid, CE: ce, PE: pe, combinedUniqueTimestamps: uniqueSignals.length, signalDiagnosticsAvailable: !cacheBlocked, global: { required: global.length, complete: global.filter((row) => row.completenessState === 'COMPLETE').length, missing: manifest.missingSessions.length, incomplete: manifest.incompleteSessions.length, malformedOrOverfull: anomalies.length, optionCandleDownloads: 0, optionCandleWrites: 0 } });
  write('signal-grid-summary.json', { grid, configs: configSummaries }); write('required-option-cache-manifest.json', manifest); write('ce-signal-diagnostics.json', { summary: ce, distribution: distributions.CE }); write('pe-signal-diagnostics.json', { summary: pe, distribution: distributions.PE }); write('monthly-signal-distribution.json', { CE: distributions.CE.monthly, PE: distributions.PE.monthly }); write('time-of-day-signal-distribution.json', { CE: distributions.CE.timeOfDay, PE: distributions.PE.timeOfDay }); write('regime-family-distribution.json', { CE: distributions.CE.regimeFamily, PE: distributions.PE.regimeFamily }); write('premium-confirmation-distribution.json', { CE: distributions.CE.premiumConfirmation, PE: distributions.PE.premiumConfirmation });
  console.log('V7 NIFTY OPTION-PREMIUM IMPULSE PHASE 1'); console.log('V7 TARGET / GRID', { ...manifest.targetDateRange, selectedConfigurations: configs.length, exhaustiveNonEquivalentConfigurations: grid.exhaustiveNonEquivalentConfigurations, intentionallyOmittedCrossInteractions: grid.intentionallyOmittedCrossInteractions }); console.log('V7 CE', ce); console.log('V7 PE', pe); console.log('V7 GLOBAL CACHE', { required: global.length, complete: global.filter((row) => row.completenessState === 'COMPLETE').length, missing: manifest.missingSessions.length, incomplete: manifest.incompleteSessions.length, malformedOrOverfull: anomalies.length, optionCandleDownloads: 0, optionCandleWrites: 0 }); console.log('V7 NO-LOOK-AHEAD', manifest.noLookAhead);
  if (cacheBlocked) { console.log('V7 PHASE 1 STOP: required local option premium data is missing, incomplete, malformed, or overfull. No outcomes or downloads were run.'); return; }
  console.log('V7 SIGNALS', { CE: ce.uniqueSignalTimestamps, PE: pe.uniqueSignalTimestamps, combined: uniqueSignals.length }); console.log('V7 PHASE 1 COMPLETE: cache is local and valid; Phase 2 was intentionally not run.');
}

function buildFeatures(prepared: readonly Prepared[], rows: ReadonlyMap<string, Candle[]>, engine: IndicatorEngineService): Map<string, V7OptionPremiumFeature> {
  const result = new Map<string, V7OptionPremiumFeature>();
  const bySession = new Map<string, V7OptionPremiumFeature[]>();
  for (const entry of prepared) { const key = sessionKey(entry.instrumentKey, entry.tradingDate); if (!bySession.has(key)) bySession.set(key, buildV7OptionPremiumFeatures(entry.candidate.direction, entry.instrumentKey, entry.tradingDate, rows.get(key) ?? [], engine)); }
  for (const entry of prepared) { const features = bySession.get(sessionKey(entry.instrumentKey, entry.tradingDate)) ?? []; const value = features.find((feature) => feature.availableAt.getTime() === entry.candidate.timestamp.getTime()); if (value) result.set(featureKey(entry.candidate.direction, entry.candidate.timestamp.getTime()), value); }
  return result;
}
async function resolveContract(candidate: BroadCandidate, client: UpstoxExpiredOptionClient, selector: OptionContractSelectorService, expiries: Map<string, Promise<string[]>>, contracts: Map<string, Promise<OptionContract[]>>): Promise<Prepared> {
  const available = await cached(expiries, underlyingInstrumentKey, () => client.fetchAvailableExpiries(underlyingInstrumentKey)); const expiry = chooseHistoricalOptionExpiry(available, candidate.date); const values = await cached(contracts, expiry, () => client.fetchExpiredOptionContracts(underlyingInstrumentKey, expiry)); const underlying = values[0]?.underlying; if (!underlying) throw new Error(`No expired-option underlying metadata for ${expiry}.`); const selection = selector.select({ underlying, spotPrice: candidate.spotPrice, signal: candidate.direction === 'CE' ? StrategySignal.BUY_CE : StrategySignal.BUY_PE, timestamp: candidate.timestamp, contracts: values }); return { candidate, instrumentKey: selection.instrumentKey, tradingDate: candidate.date, selection };
}
function distributionsFor(signals: readonly ReturnType<typeof deduplicateV7Signals>[number][]) { const buckets: ReadonlyArray<readonly [string,number,number]>=[['09:15-10:30',555,630],['10:30-12:00',630,720],['12:00-13:30',720,810],['13:30-15:30',810,930]]; return { monthly: ['2026-03','2026-04','2026-05','2026-06','2026-07','2026-08'].map((prefix) => ({ month: prefix === '2026-08' ? 'Aug 1-4' : prefix, signals: signals.filter((signal) => signal.date.startsWith(prefix)).length })), timeOfDay: buckets.map(([bucket,start,end]) => ({ bucket, signals: signals.filter((signal) => { const minute = istMinute(signal.timestamp); return minute >= start && minute < end; }).length })), regimeFamily: ['NO_REGIME_FILTER','DIRECTION_ALIGNED_REGIME'].map((family) => ({ family, signals: signals.filter((signal) => signal.regimeFamily === family).length })), underlyingTimeframe: [1,2].map((timeframe) => ({ timeframe: `${timeframe}m`, signals: signals.filter((signal) => signal.underlyingTimeframe === timeframe).length })), premiumConfirmation: ['RETURN_ONLY','BODY_AND_RETURN','BREAKOUT_AND_RETURN','BODY_BREAKOUT_AND_RETURN'].map((family) => ({ family, signals: signals.filter((signal) => signal.premiumConfirmation === family).length })) }; }
function selectionFor(signal: ReturnType<typeof deduplicateV7Signals>[number], prepared: readonly Prepared[]) { return prepared.find((entry) => entry.candidate.direction === signal.direction && entry.candidate.timestamp.getTime() === signal.timestamp.getTime()); }
function validSession(candles: readonly Candle[], requestedDate: string | undefined) { const ordered = [...candles].sort((left, right) => left.timestamp.getTime() - right.timestamp.getTime()); const reasons: string[] = []; if (ordered.length !== 375) reasons.push(`rowCount=${ordered.length}, expected=375`); if (ordered.some((value) => requestedDate !== undefined && istDate(value.timestamp) !== requestedDate)) reasons.push('wrongIstTradingDate'); if (ordered.some((value, index) => index > 0 && value.timestamp.getTime() === ordered[index - 1].timestamp.getTime())) reasons.push('duplicateTimestamp'); if (ordered[0] && istMinute(ordered[0].timestamp) !== 555) reasons.push(`firstMinute=${istMinute(ordered[0].timestamp)}, expected=555`); if (ordered.at(-1) && istMinute(ordered.at(-1)!.timestamp) !== 929) reasons.push(`lastMinute=${istMinute(ordered.at(-1)!.timestamp)}, expected=929`); if (ordered.some((value, index) => index > 0 && value.timestamp.getTime() - ordered[index - 1].timestamp.getTime() !== 60_000)) reasons.push('missingOrNonContinuousMinute'); if (ordered.some((value) => ![value.open,value.high,value.low,value.close].every(Number.isFinite) || value.high < Math.max(value.open,value.close,value.low) || value.low > Math.min(value.open,value.close,value.high))) reasons.push('invalidOhlc'); return { valid: reasons.length === 0, reasons, rowCount: ordered.length, first: ordered[0] ? istTimestamp(ordered[0].timestamp) : undefined, last: ordered.at(-1) ? istTimestamp(ordered.at(-1)!.timestamp) : undefined }; }
function istDate(value: Date) { const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(value).map((x)=>[x.type,x.value])); return `${p.year}-${p.month}-${p.day}`; }
function istTimestamp(value: Date) { return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(value); }
function istMinute(value: Date) { const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Kolkata',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(value).map((x)=>[x.type,x.value])); return Number(p.hour)*60+Number(p.minute); }
function sessionKey(instrumentKey: string, tradingDate: string) { return `${instrumentKey}\u0000${tradingDate}`; }
function write(name: string, value: unknown) { writeFileSync(resolve(artifactsDirectory,name),`${JSON.stringify(value,null,2)}\n`); }
function cached<T>(map: Map<string, Promise<T>>, key: string, fn: () => Promise<T>) { const found = map.get(key); if (found) return found; const value = fn(); map.set(key,value); return value; }
async function mapConcurrent<T,R>(items: readonly T[], concurrency: number, fn: (item:T)=>Promise<R>):Promise<R[]> { const result=new Array<R>(items.length);let next=0;await Promise.all(Array.from({length:Math.min(concurrency,items.length)},async()=>{while(true){const index=next++;if(index>=items.length)return;result[index]=await fn(items[index]);}}));return result; }
function round(value:number){return Number(value.toFixed(2));} function dateInput(value:string){if(!/^\d{4}-\d{2}-\d{2}$/.test(value))throw new Error('RESEARCH_END_DATE must be YYYY-MM-DD.');return value;}
run().catch((error)=>{console.error('V7 option-premium impulse Phase 1 failed.',error);process.exitCode=1;});
