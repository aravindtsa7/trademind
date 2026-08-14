import 'dotenv/config';
import { mkdir, writeFile } from 'node:fs/promises';
import { Prisma } from '@prisma/client';
import logger from '../core/logger/logger';
import HistoricalCandleRepository from '../modules/historical-candles/repositories/historical-candle.repository';
import HistoricalOptionCandleRepository from '../modules/options/repositories/historical-option-candle.repository';
import UpstoxExpiredOptionClient from '../modules/options/client/upstox-expired-option.client';
import UpstoxExpiredOptionCandleClient from '../modules/options/client/upstox-expired-option-candle.client';
import { OptionContract } from '../modules/options/types';
import { calendarWeekdays, istDate, istMinute } from '../modules/research/banknifty-data-audit';

logger.silent = true;

const underlyingKey = 'NSE_INDEX|Nifty Bank';
const underlyingTimeframe = '1minute';
const fromDate = '2026-03-02';
const toDate = '2026-08-04';
const optionTimeframe = '1minute';
const artifactDirectory = 'artifacts/banknifty-option-prep';
const sessionStart = 555;
const sessionEnd = 929;
const maxAttempts = 3;
const workerCount = 6;

type CacheStatus = 'COMPLETE' | 'USABLE_SPARSE' | 'INCOMPLETE_DATA' | 'NO_TRADES' | 'METADATA_UNAVAILABLE';
interface Requirement { tradingDate: string; direction: 'CE' | 'PE'; offset: 'ATM' | 'ATM_MINUS_1' | 'ATM_PLUS_1'; instrumentKey: string; expiry: string; strike: number; tradingSymbol: string; }
interface CandleLike { instrumentKey: string; candleTime: Date; open: number; high: number; low: number; close: number; volume: bigint; openInterest?: bigint; }
interface Validation { status: CacheStatus; rowCount: number; missingMinutes: number; duplicateTimestamps: string[]; invalidOhlc: number; firstIst: string | null; lastIst: string | null; outOfSessionTimestamps: string[]; flatPriceSequenceCount: number; reason?: string; }
interface Stats { metadataRequests: number; optionCandleRequests: number; retryCount: number; cacheWrites: number; downloadedRows: number; successfulDownloads: number; failedDownloads: number; }

function dayBounds(date: string) { return { from: new Date(`${date}T00:00:00+05:30`), to: new Date(`${date}T23:59:59.999+05:30`) }; }
function istLabel(date: Date): string { const minute = istMinute(date); return `${istDate(date)} ${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')} IST`; }
function contractExpiryDate(contract: OptionContract): string { return istDate(contract.expiry); }
function chooseExpiry(expiries: readonly string[], tradingDate: string): string | null { return expiries.filter((expiry) => expiry >= tradingDate).sort()[0] ?? null; }
function pickStrike(strikes: readonly number[], spot: number): number | null { return [...strikes].sort((a, b) => Math.abs(a - spot) - Math.abs(b - spot) || a - b)[0] ?? null; }
function parseError(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function protectedSplit(dates: readonly string[]) {
  const ordered = [...dates].sort();
  if (ordered.length === 0) return { status: 'NOT_PROPOSED_NO_ELIGIBLE_SESSIONS', assignments: [] };
  const holdout = Math.min(18, ordered.length);
  const validation = Math.min(20, Math.max(0, ordered.length - holdout - 6));
  const train = Math.max(0, ordered.length - holdout - validation - 6);
  return {
    status: 'PROPOSED_FROM_ELIGIBLE_DATES',
    policy: { train, embargo1: Math.min(3, ordered.length - train), validation, embargo2: Math.min(3, ordered.length - train - 3 - validation), legacyContaminatedHoldout: holdout },
    assignments: ordered.map((tradingDate, index) => ({ sessionIndex: index, tradingDate, split: index < train ? 'TRAIN' : index < train + 3 ? 'EMBARGO_1' : index < train + 3 + validation ? 'VALIDATION' : index < train + 6 + validation ? 'EMBARGO_2' : 'LEGACY_CONTAMINATED_HOLDOUT' })),
  };
}

function validateCandles(candles: readonly CandleLike[], tradingDate: string): Validation {
  const sorted = [...candles].sort((a, b) => a.candleTime.getTime() - b.candleTime.getTime());
  const expectedStart = new Date(`${tradingDate}T09:15:00+05:30`).getTime();
  const expected = new Set(Array.from({ length: 375 }, (_, index) => expectedStart + index * 60_000));
  const seen = new Map<number, number>();
  const duplicateTimestamps: string[] = [];
  let invalidOhlc = 0;
  let flatPriceSequenceCount = 0;
  for (let index = 0; index < sorted.length; index += 1) {
    const candle = sorted[index]; const timestamp = candle.candleTime.getTime();
    seen.set(timestamp, (seen.get(timestamp) ?? 0) + 1);
    if ((seen.get(timestamp) ?? 0) > 1) duplicateTimestamps.push(istLabel(candle.candleTime));
    if (!Number.isFinite(candle.open) || !Number.isFinite(candle.high) || !Number.isFinite(candle.low) || !Number.isFinite(candle.close) || candle.high < Math.max(candle.open, candle.close) || candle.low > Math.min(candle.open, candle.close) || candle.high < candle.low) invalidOhlc += 1;
    if (index > 0 && candle.open === candle.high && candle.high === candle.low && candle.low === candle.close && sorted[index - 1].close === candle.close) flatPriceSequenceCount += 1;
  }
  const regular = sorted.filter((candle) => istDate(candle.candleTime) === tradingDate && istMinute(candle.candleTime) >= sessionStart && istMinute(candle.candleTime) <= sessionEnd);
  const timestamps = new Set(regular.map((candle) => candle.candleTime.getTime()));
  const missingMinutes = [...expected].filter((timestamp) => !timestamps.has(timestamp)).length;
  const outOfSessionTimestamps = sorted.filter((candle) => !expected.has(candle.candleTime.getTime())).map((candle) => istLabel(candle.candleTime));
  const monotonic = sorted.every((candle, index) => index === 0 || candle.candleTime.getTime() > sorted[index - 1].candleTime.getTime());
  if (candles.length === 0) return { status: 'NO_TRADES', rowCount: 0, missingMinutes: 375, duplicateTimestamps, invalidOhlc, firstIst: null, lastIst: null, outOfSessionTimestamps, flatPriceSequenceCount, reason: 'remote response contained no candles' };
  if (invalidOhlc > 0 || duplicateTimestamps.length > 0 || outOfSessionTimestamps.length > 0 || !monotonic || regular.some((candle, index) => index > 0 && candle.candleTime.getTime() - regular[index - 1].candleTime.getTime() !== 60_000)) return { status: 'INCOMPLETE_DATA', rowCount: candles.length, missingMinutes, duplicateTimestamps, invalidOhlc, firstIst: sorted[0] ? istLabel(sorted[0].candleTime) : null, lastIst: sorted.at(-1) ? istLabel(sorted.at(-1)!.candleTime) : null, outOfSessionTimestamps, flatPriceSequenceCount, reason: 'duplicate, malformed, non-monotonic, gapped, wrong-date or out-of-session response' };
  const status: CacheStatus = regular.length === 375 && missingMinutes === 0 && istMinute(regular[0].candleTime) === sessionStart && istMinute(regular.at(-1)!.candleTime) === sessionEnd ? 'COMPLETE' : 'USABLE_SPARSE';
  return { status, rowCount: regular.length, missingMinutes, duplicateTimestamps, invalidOhlc, firstIst: regular[0] ? istLabel(regular[0].candleTime) : null, lastIst: regular.at(-1) ? istLabel(regular.at(-1)!.candleTime) : null, outOfSessionTimestamps, flatPriceSequenceCount, reason: status === 'USABLE_SPARSE' ? 'valid regular-session candles with sparse coverage' : undefined };
}

async function runWorkers<T>(items: readonly T[], work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(workerCount, items.length) }, async () => { while (true) { const index = next++; if (index >= items.length) return; await work(items[index]); } }));
}

async function run(): Promise<void> {
  const token = process.env.UPSTOX_ACCESS_TOKEN?.trim();
  if (!token) throw new Error('UPSTOX_ACCESS_TOKEN is required for BANK NIFTY option preparation.');
  const candleRepository = new HistoricalCandleRepository();
  const optionRepository = new HistoricalOptionCandleRepository();
  const metadataClient = new UpstoxExpiredOptionClient(token);
  const candleClient = new UpstoxExpiredOptionCandleClient(token);
  const stats: Stats = { metadataRequests: 0, optionCandleRequests: 0, retryCount: 0, cacheWrites: 0, downloadedRows: 0, successfulDownloads: 0, failedDownloads: 0 };
  stats.metadataRequests += 1;
  const allExpiries = (await metadataClient.fetchAvailableExpiries(underlyingKey)).sort();
  const relevantExpiries = allExpiries.filter((expiry) => expiry <= toDate && expiry >= fromDate);
  const contractsByExpiry = new Map<string, OptionContract[]>();
  for (const expiry of relevantExpiries) { stats.metadataRequests += 1; contractsByExpiry.set(expiry, await metadataClient.fetchExpiredOptionContracts(underlyingKey, expiry)); }
  const observedStrikes = [...new Set([...contractsByExpiry.values()].flatMap((contracts) => contracts.map((contract) => contract.strikePrice)))].sort((a, b) => a - b);
  const strikeSpacing = [...new Set(observedStrikes.slice(1).map((strike, index) => strike - observedStrikes[index]))].sort((a, b) => a - b);
  const underlyingRows = await candleRepository.findRange(underlyingKey, underlyingTimeframe, dayBounds(fromDate).from, dayBounds(toDate).to);
  const sessions = new Map<string, typeof underlyingRows>();
  underlyingRows.forEach((row) => { const date = istDate(row.candleTime); sessions.set(date, [...(sessions.get(date) ?? []), row]); });
  const validUnderlyingDates = calendarWeekdays(fromDate, toDate).filter((date) => sessions.get(date)?.length === 375);
  const metadataCoverage = validUnderlyingDates.map((tradingDate) => {
    const expiry = chooseExpiry(relevantExpiries, tradingDate);
    const rows = sessions.get(tradingDate) ?? [];
    const spot = Number(rows.find((row) => istMinute(row.candleTime) === sessionStart)?.close ?? rows[0]?.close ?? 0);
    const contracts = expiry ? contractsByExpiry.get(expiry) ?? [] : [];
    const strikes = [...new Set(contracts.map((contract) => contract.strikePrice))].sort((a, b) => a - b);
    const atm = expiry ? pickStrike(strikes, spot) : null;
    const index = atm === null ? -1 : strikes.indexOf(atm);
    return { tradingDate, spot, expiry, strikeLadderCount: strikes.length, atmStrike: atm, nearestLowerStrike: index > 0 ? strikes[index - 1] : null, nearestHigherStrike: index >= 0 && index < strikes.length - 1 ? strikes[index + 1] : null, metadataStatus: expiry && atm !== null ? 'AVAILABLE' : 'METADATA_UNAVAILABLE' as const };
  });
  const requirements: Requirement[] = [];
  metadataCoverage.forEach((session) => {
    if (!session.expiry || session.atmStrike === null) return;
    const contracts = contractsByExpiry.get(session.expiry) ?? [];
    const strikes = [session.atmStrike, session.nearestLowerStrike, session.nearestHigherStrike].filter((strike): strike is number => strike !== null);
    const offsets: Array<Requirement['offset']> = ['ATM', 'ATM_MINUS_1', 'ATM_PLUS_1'];
    (['CE', 'PE'] as const).forEach((direction) => strikes.forEach((strike, index) => {
      const contract = contracts.find((candidate) => candidate.optionType === direction && candidate.strikePrice === strike);
      if (contract) requirements.push({ tradingDate: session.tradingDate, direction, offset: offsets[index], instrumentKey: contract.instrumentKey, expiry: session.expiry!, strike, tradingSymbol: contract.tradingSymbol });
    }));
  });
  const uniqueRequirements = [...new Map(requirements.map((requirement) => [`${requirement.instrumentKey}|${requirement.tradingDate}`, requirement])).values()];
  const existingRows = await optionRepository.findByInstrumentDateSessions(uniqueRequirements, optionTimeframe);
  const localByKey = new Map<string, CandleLike[]>();
  existingRows.forEach((row) => { const key = `${row.instrumentKey}|${istDate(row.candleTime)}`; localByKey.set(key, [...(localByKey.get(key) ?? []), { instrumentKey: row.instrumentKey, candleTime: row.candleTime, open: Number(row.open), high: Number(row.high), low: Number(row.low), close: Number(row.close), volume: row.volume, openInterest: row.openInterest ?? undefined }]); });
  const validations = new Map<string, Validation>();
  uniqueRequirements.forEach((requirement) => validations.set(`${requirement.instrumentKey}|${requirement.tradingDate}`, validateCandles(localByKey.get(`${requirement.instrumentKey}|${requirement.tradingDate}`) ?? [], requirement.tradingDate)));
  const fetchTargets = uniqueRequirements.filter((requirement) => validations.get(`${requirement.instrumentKey}|${requirement.tradingDate}`)?.status !== 'COMPLETE');
  const failures: Array<{ requirement: Requirement; status: CacheStatus; reason: string; rowCount: number }> = [];
  await runWorkers(fetchTargets, async (requirement) => {
    const key = `${requirement.instrumentKey}|${requirement.tradingDate}`;
    let candles: CandleLike[] = [];
    let lastError = '';
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      stats.optionCandleRequests += 1;
      try { candles = await candleClient.fetchCandles(requirement.instrumentKey, requirement.tradingDate, requirement.tradingDate); stats.downloadedRows += candles.length; break; } catch (error) { lastError = parseError(error); if (attempt < maxAttempts) { stats.retryCount += 1; await new Promise((resolve) => setTimeout(resolve, attempt * 500)); } }
    }
    const validation = validateCandles(candles, requirement.tradingDate);
    validations.set(key, validation);
    if (validation.status === 'COMPLETE' || validation.status === 'USABLE_SPARSE') {
      const regular = candles.filter((candle) => istDate(candle.candleTime) === requirement.tradingDate && istMinute(candle.candleTime) >= sessionStart && istMinute(candle.candleTime) <= sessionEnd);
      if (regular.length > 0) {
        await optionRepository.bulkUpsert(regular.map((candle) => ({ instrumentKey: requirement.instrumentKey, timeframe: optionTimeframe, candleTime: candle.candleTime, tradingSymbol: requirement.tradingSymbol, optionType: requirement.direction, strikePrice: new Prisma.Decimal(requirement.strike), expiry: new Date(`${requirement.expiry}T00:00:00+05:30`), open: new Prisma.Decimal(candle.open), high: new Prisma.Decimal(candle.high), low: new Prisma.Decimal(candle.low), close: new Prisma.Decimal(candle.close), volume: candle.volume, openInterest: candle.openInterest })));
        stats.cacheWrites += regular.length; stats.successfulDownloads += 1; return;
      }
    }
    stats.failedDownloads += 1;
    const failedStatus: CacheStatus = validation.status === 'NO_TRADES' ? 'NO_TRADES' : validation.status === 'INCOMPLETE_DATA' ? 'INCOMPLETE_DATA' : 'INCOMPLETE_DATA';
    validations.set(key, { ...validation, status: failedStatus, reason: validation.reason ?? lastError });
    failures.push({ requirement, status: failedStatus, reason: validation.reason ?? lastError, rowCount: validation.rowCount });
  });
  const finalRows = await optionRepository.findByInstrumentDateSessions(uniqueRequirements, optionTimeframe);
  const finalByKey = new Map<string, CandleLike[]>();
  finalRows.forEach((row) => { const key = `${row.instrumentKey}|${istDate(row.candleTime)}`; finalByKey.set(key, [...(finalByKey.get(key) ?? []), { instrumentKey: row.instrumentKey, candleTime: row.candleTime, open: Number(row.open), high: Number(row.high), low: Number(row.low), close: Number(row.close), volume: row.volume, openInterest: row.openInterest ?? undefined }]); });
  uniqueRequirements.forEach((requirement) => validations.set(`${requirement.instrumentKey}|${requirement.tradingDate}`, validateCandles(finalByKey.get(`${requirement.instrumentKey}|${requirement.tradingDate}`) ?? [], requirement.tradingDate)));
  const directionCoverage = (direction: 'CE' | 'PE') => { const items = uniqueRequirements.filter((requirement) => requirement.direction === direction); const states = items.map((item) => validations.get(`${item.instrumentKey}|${item.tradingDate}`)?.status ?? 'NO_TRADES'); const complete = states.filter((state) => state === 'COMPLETE').length; const usableSparse = states.filter((state) => state === 'USABLE_SPARSE').length; return { required: items.length, complete, usableSparse, incomplete: states.filter((state) => state === 'INCOMPLETE_DATA').length, noTrades: states.filter((state) => state === 'NO_TRADES').length, metadataUnavailable: metadataCoverage.filter((session) => session.metadataStatus === 'METADATA_UNAVAILABLE').length, completeCoveragePercent: items.length ? Number((complete / items.length * 100).toFixed(2)) : 0, researchUsableCoveragePercent: items.length ? Number(((complete + usableSparse) / items.length * 100).toFixed(2)) : 0 }; };
  const ce = directionCoverage('CE'); const pe = directionCoverage('PE');
  const eligibleDates = metadataCoverage.filter((session) => session.metadataStatus === 'AVAILABLE' && (['CE', 'PE'] as const).every((direction) => uniqueRequirements.filter((requirement) => requirement.tradingDate === session.tradingDate && requirement.direction === direction).every((requirement) => ['COMPLETE', 'USABLE_SPARSE'].includes(validations.get(`${requirement.instrumentKey}|${requirement.tradingDate}`)?.status ?? 'NO_TRADES')))).map((session) => session.tradingDate);
  await mkdir(artifactDirectory, { recursive: true });
  await writeFile(`${artifactDirectory}/metadata-coverage.json`, JSON.stringify({ underlyingKey, requestedRange: { fromDate, toDate }, availableExpiryCount: allExpiries.length, earliestAvailableExpiry: allExpiries[0] ?? null, latestAvailableExpiry: allExpiries.at(-1) ?? null, weeklyExpiryCount: relevantExpiries.filter((expiry) => new Date(`${expiry}T00:00:00Z`).getUTCDate() < 24).length, monthlyExpiryCount: relevantExpiries.filter((expiry) => new Date(`${expiry}T00:00:00Z`).getUTCDate() >= 24).length, observedStrikeSpacing: strikeSpacing, underlyingSessions: validUnderlyingDates.length, sessionsWithMetadata: metadataCoverage.filter((session) => session.metadataStatus === 'AVAILABLE').length, sessionsWithoutMetadata: metadataCoverage.filter((session) => session.metadataStatus === 'METADATA_UNAVAILABLE').length, missingMetadataDates: metadataCoverage.filter((session) => session.metadataStatus === 'METADATA_UNAVAILABLE').map((session) => session.tradingDate), observedExpiryStructure: [...new Set(metadataCoverage.map((session) => session.expiry).filter(Boolean))], sessions: metadataCoverage }, null, 2));
  await writeFile(`${artifactDirectory}/required-option-universe.json`, JSON.stringify({ selectionSemantics: '09:15 IST underlying close; nearest available strike with lower-strike tie break; adjacent metadata ladder strikes ATM-1/ATM+1; nearest expiry on or after trading date; CE and PE independently', totalUniqueOptionInstrumentSessions: uniqueRequirements.length, requirements: uniqueRequirements }, null, 2));
  await writeFile(`${artifactDirectory}/option-cache-manifest.json`, JSON.stringify({ required: uniqueRequirements.map((requirement) => ({ ...requirement, status: validations.get(`${requirement.instrumentKey}|${requirement.tradingDate}`)?.status ?? 'NO_TRADES' })), failures }, null, 2));
  await writeFile(`${artifactDirectory}/option-data-quality.json`, JSON.stringify({ ce, pe, global: { required: uniqueRequirements.length, complete: [...validations.values()].filter((validation) => validation.status === 'COMPLETE').length, usableSparse: [...validations.values()].filter((validation) => validation.status === 'USABLE_SPARSE').length, incomplete: [...validations.values()].filter((validation) => validation.status === 'INCOMPLETE_DATA').length, noTrades: [...validations.values()].filter((validation) => validation.status === 'NO_TRADES').length }, validationSummary: [...validations.entries()].map(([key, validation]) => ({ key, ...validation })) }, null, 2));
  await writeFile(`${artifactDirectory}/research-session-eligibility.json`, JSON.stringify({ underlyingSessions: validUnderlyingDates.length, metadataUsableSessions: metadataCoverage.filter((session) => session.metadataStatus === 'AVAILABLE').length, eligibleForBothDirections: eligibleDates.length, eligibleDates, excludedDates: metadataCoverage.filter((session) => !eligibleDates.includes(session.tradingDate)).map((session) => ({ tradingDate: session.tradingDate, reason: session.metadataStatus === 'METADATA_UNAVAILABLE' ? 'METADATA_UNAVAILABLE' : 'OPTION_CACHE_NOT_RESEARCH_USABLE' })), proposedSplit: protectedSplit(eligibleDates) }, null, 2));
  const verdict = eligibleDates.length >= 80 && failures.length === 0 ? 'READY_FOR_STRATEGY_RESEARCH_WITH_LIMITATIONS' : 'NOT_READY_FOR_STRATEGY_RESEARCH';
  await writeFile(`${artifactDirectory}/option-prep-summary.json`, JSON.stringify({ verdict, underlyingSessions: validUnderlyingDates.length, sessionsWithValidMetadata: metadataCoverage.filter((session) => session.metadataStatus === 'AVAILABLE').length, sessionsWithoutMetadata: metadataCoverage.filter((session) => session.metadataStatus === 'METADATA_UNAVAILABLE').length, uniqueRequiredOptionInstrumentSessions: uniqueRequirements.length, completeOptionSessions: [...validations.values()].filter((validation) => validation.status === 'COMPLETE').length, usableSparseSessions: [...validations.values()].filter((validation) => validation.status === 'USABLE_SPARSE').length, incompleteSessions: [...validations.values()].filter((validation) => validation.status === 'INCOMPLETE_DATA').length, noTradeSessions: [...validations.values()].filter((validation) => validation.status === 'NO_TRADES').length, ceCoverage: ce, peCoverage: pe, expiryDayCoverage: metadataCoverage.filter((session) => session.expiry === session.tradingDate).length, networkRequests: { metadata: stats.metadataRequests, optionCandles: stats.optionCandleRequests, total: stats.metadataRequests + stats.optionCandleRequests }, retryCount: stats.retryCount, downloadedRows: stats.downloadedRows, cacheWrites: stats.cacheWrites, failedDownloads: stats.failedDownloads, failures, eligibleDates }, null, 2));
  console.log(JSON.stringify({ verdict, expiryStructure: [...new Set(metadataCoverage.map((session) => session.expiry).filter(Boolean))], underlyingSessions: validUnderlyingDates.length, sessionsWithValidMetadata: metadataCoverage.filter((session) => session.metadataStatus === 'AVAILABLE').length, sessionsWithoutMetadata: metadataCoverage.filter((session) => session.metadataStatus === 'METADATA_UNAVAILABLE').length, uniqueRequiredOptionInstrumentSessions: uniqueRequirements.length, ce, pe, eligibleForBothDirections: eligibleDates.length, networkRequests: { metadata: stats.metadataRequests, optionCandles: stats.optionCandleRequests, total: stats.metadataRequests + stats.optionCandleRequests }, retryCount: stats.retryCount, downloadedRows: stats.downloadedRows, cacheWrites: stats.cacheWrites, failedDownloads: stats.failedDownloads, missingMetadataDates: metadataCoverage.filter((session) => session.metadataStatus === 'METADATA_UNAVAILABLE').map((session) => session.tradingDate), verdictLabel: verdict }, null, 2));
}

void run().catch((error) => { console.error('BANK NIFTY option preparation failed.', error); process.exitCode = 1; });
