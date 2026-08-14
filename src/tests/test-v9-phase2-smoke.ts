import 'dotenv/config';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import HistoricalCandleRepository from '../modules/historical-candles/repositories/historical-candle.repository';
import HistoricalOptionCandleRepository from '../modules/options/repositories/historical-option-candle.repository';
import CandleTimeframeAggregatorService from '../modules/indicators/services/candle-timeframe-aggregator.service';
import IndicatorEngineService from '../modules/indicators/services/indicator-engine.service';
import { IndicatorType } from '../modules/indicators/types';
import AdaptiveMarketRegimeService from '../modules/adaptive-intraday/services/adaptive-market-regime.service';
import OptionPremiumPathAnalysisService from '../modules/options/services/option-premium-path-analysis.service';
import { filterCrossSessionResearchTargets, prepareCrossSessionIndicatorWarmup } from './helpers/cross-session-indicator-warmup';
import { adaptV9OptionCandles } from '../modules/research/v9-nifty-volatility-expansion/v9-option-candle-adapter';
import { assertV9NoLookAhead, createV9Configs, generateV9Signals, V9Config, V9OptionCandle, V9OptionResolver, V9PreparedSession, V9Signal, v9ConfigKey } from '../modules/research/v9-nifty-volatility-expansion';

const INSTRUMENT = 'NSE_INDEX|Nifty 50';
const END_DATE = '2026-08-04';
const POLICY = { type: 'TARGET_STOP' as const, targetPercent: 5, stopLossPercent: 5, maximumHoldingMinutes: 15 };
const NETWORK_REQUESTS = 0;
const CACHE_WRITES = 0;

type ContractSelection = { direction: 'CE' | 'PE'; instrumentKey: string; tradingDate: string; timestamp: string; expiry?: string; strikePrice?: number };
type SmokeResult = {
  direction: 'CE' | 'PE'; configKey: string; tradingDate: string; signalTimestamp: string; signalTimestampIst: string; underlyingClose: number;
  optionInstrumentKey: string; optionExpiry: string | null; selectedStrike: number | null; optionCandleCountLoaded: number;
  entryCandleTimestamp: string | null; entryCandleTimestampIst: string | null; outcome: string; exitTimestamp: string | null; exitTimestampIst: string | null; entryPremium: number | null; exitPremium: number | null;
  returnPercent: number | null; ambiguous: boolean; unavailable: boolean; networkRequests: number; cacheWrites: number;
};

async function run(): Promise<void> {
  if (process.env.RESEARCH_LOCAL_ONLY !== 'true') throw new Error('V9 phase-2 smoke requires RESEARCH_LOCAL_ONLY=true.');
  const context = await loadTrainOnlyContext();
  const fixedConfig = fixedSmokeConfig();
  const ceFirst = runSmokeCase('CE', fixedConfig, context);
  const ceSecond = runSmokeCase('CE', fixedConfig, context);
  assert.deepEqual(ceSecond, ceFirst, 'CE smoke rerun must be deterministic.');
  console.log('V9_CE_PHASE2_SMOKE');
  console.log(JSON.stringify(ceFirst, null, 2));

  const peFirst = runSmokeCase('PE', fixedConfig, context);
  const peSecond = runSmokeCase('PE', fixedConfig, context);
  assert.deepEqual(peSecond, peFirst, 'PE smoke rerun must be deterministic.');
  console.log('V9_PE_PHASE2_SMOKE');
  console.log(JSON.stringify(peFirst, null, 2));
  console.log('CE_SMOKE_PASS');
  console.log('PE_SMOKE_PASS');
}

function fixedSmokeConfig(): V9Config {
  const config = createV9Configs().find((candidate) => candidate.timeframe === 2
    && candidate.compressionLookback === 20
    && candidate.compressionThreshold === 0.9
    && candidate.expansionBodyThreshold === 0.75
    && candidate.expansionRangeThreshold === 1
    && candidate.breakoutLookback === 5
    && candidate.regimeMode === 'NO_REGIME_FILTER'
    && candidate.optionConfirmation === 'RETURN_0.75'
    && candidate.cooldownMinutes === 10);
  if (!config) throw new Error('Fixed V9 smoke configuration is not present in the frozen 960-config plan.');
  return config;
}

async function loadTrainOnlyContext(): Promise<{
  sessions: V9PreparedSession[]; atrByFrame: Map<any, Map<number, number>>; resolver: V9OptionResolver;
  rawRowsBySession: Map<string, any[]>; selections: Map<string, ContractSelection[]>;
}> {
  const split = JSON.parse(readFileSync(resolve(process.cwd(), 'artifacts/research-validation/nifty-104-split-v1.json'), 'utf8'));
  const trainDates = new Set<string>(split.sessions.filter((session: any) => session.split === 'TRAIN' && session.tradingDate <= END_DATE).map((session: any) => session.tradingDate));
  if (trainDates.size !== 60) throw new Error(`Expected 60 protected TRAIN sessions, found ${trainDates.size}.`);

  const underlyingRows = await new HistoricalCandleRepository().findByInstrumentAndTimeframe(INSTRUMENT, '1minute');
  const underlyingByDate = new Map<string, any[]>();
  underlyingRows.forEach((row: any) => {
    const candle = { timestamp: new Date(row.candleTime), open: Number(row.open), high: Number(row.high), low: Number(row.low), close: Number(row.close), volume: Number(row.volume) };
    const date = istDate(candle.timestamp);
    underlyingByDate.set(date, [...(underlyingByDate.get(date) ?? []), candle]);
  });
  const completeSessions = [...underlyingByDate.entries()]
    .filter(([, candles]) => isCompleteSession(candles))
    .sort(([left], [right]) => left.localeCompare(right));
  const warmed = filterCrossSessionResearchTargets(
    prepareCrossSessionIndicatorWarmup(
      completeSessions.map(([date, candles]) => ({ date, candles })),
      new CandleTimeframeAggregatorService(),
      new IndicatorEngineService(),
      new AdaptiveMarketRegimeService({ trendStrengthThreshold: 20, emaProximityPercent: 0.05, highVolatilityThreshold: 0.1, lowVolatilityThreshold: 0.05 }),
    ),
    END_DATE,
  ).filter((session: any) => trainDates.has(session.date));
  if (warmed.length !== trainDates.size) throw new Error(`TRAIN warm-up preparation produced ${warmed.length}/${trainDates.size} sessions.`);
  const sessions = warmed.map((session: any) => ({ date: session.date, frames: { 2: session.frames[2].candles, 3: session.frames[3].candles }, regimePoints: session.regimePoints })) as V9PreparedSession[];
  const atrByFrame = buildAtrMaps(sessions);

  // This is the frozen V9 phase-1/V7-selected contract mapping. The smoke run only reads it.
  const manifest = JSON.parse(readFileSync(resolve(process.cwd(), 'artifacts/v7-option-impulse/required-option-cache-manifest.json'), 'utf8'));
  const contracts = (manifest.selectedContracts as ContractSelection[]).filter((contract) => trainDates.has(contract.tradingDate));
  const uniqueSessions = [...new Map(contracts.map((contract) => [`${contract.instrumentKey}|${contract.tradingDate}`, contract])).values()];
  const rawRows = await new HistoricalOptionCandleRepository().findByInstrumentDateSessions(uniqueSessions.map((contract) => ({ instrumentKey: contract.instrumentKey, tradingDate: contract.tradingDate })), '1minute');
  const rawRowsBySession = new Map<string, any[]>();
  const signalCandlesBySession = new Map<string, V9OptionCandle[]>();
  rawRows.forEach((row: any) => {
    const key = `${row.instrumentKey}|${istDate(new Date(row.candleTime))}`;
    rawRowsBySession.set(key, [...(rawRowsBySession.get(key) ?? []), row]);
    signalCandlesBySession.set(key, [...(signalCandlesBySession.get(key) ?? []), { timestamp: new Date(row.candleTime), open: Number(row.open), high: Number(row.high), low: Number(row.low), close: Number(row.close), instrumentKey: row.instrumentKey }]);
  });
  const selections = new Map<string, ContractSelection[]>();
  contracts.forEach((contract) => {
    const key = `${contract.direction}|${contract.tradingDate}`;
    selections.set(key, [...(selections.get(key) ?? []), contract]);
  });
  const resolver: V9OptionResolver = {
    resolve(direction, date, completedAt) {
      const candidates = (selections.get(`${direction}|${date}`) ?? [])
        .filter((contract) => new Date(contract.timestamp).getTime() <= completedAt.getTime())
        .sort((left, right) => new Date(right.timestamp).getTime() - new Date(left.timestamp).getTime());
      const selected = candidates[0] ?? selections.get(`${direction}|${date}`)?.[0];
      return selected ? { instrumentKey: selected.instrumentKey, expiry: selected.expiry, strike: selected.strikePrice } : undefined;
    },
    candles(instrumentKey, date) { return signalCandlesBySession.get(`${instrumentKey}|${date}`) ?? []; },
  };
  return { sessions, atrByFrame, resolver, rawRowsBySession, selections };
}

function runSmokeCase(direction: 'CE' | 'PE', config: V9Config, context: Awaited<ReturnType<typeof loadTrainOnlyContext>>): SmokeResult {
  const signals = generateV9Signals(context.sessions, config, { atrByFrame: context.atrByFrame }, context.resolver);
  assertV9NoLookAhead(signals);
  const signal = signals.filter((candidate) => candidate.direction === direction).sort((left, right) => left.timestamp.getTime() - right.timestamp.getTime())[0];
  if (!signal) throw new Error(`No legal ${direction} signal exists for fixed V9 smoke configuration ${v9ConfigKey(config)} in protected TRAIN.`);
  const sessionKey = `${signal.optionInstrumentKey}|${signal.date}`;
  const rawRows = context.rawRowsBySession.get(sessionKey) ?? [];
  if (rawRows.length === 0) throw new Error(`V9 ${direction} smoke local cache is missing ${sessionKey}.`);
  const adapted = adaptV9OptionCandles(rawRows);
  const entryCandle = adapted.find((candle) => candle.candleTime.getTime() === signal.timestamp.getTime());
  const selection = selectContract(context.selections, direction, signal.date, signal.timestamp);
  if (!selection || selection.instrumentKey !== signal.optionInstrumentKey) throw new Error(`V9 ${direction} smoke contract resolution mismatch at ${signal.timestamp.toISOString()}.`);
  const outcome = new OptionPremiumPathAnalysisService(signal.timestamp, adapted).evaluate(POLICY);
  return {
    direction, configKey: v9ConfigKey(config), tradingDate: signal.date, signalTimestamp: signal.timestamp.toISOString(), signalTimestampIst: istTimestamp(signal.timestamp), underlyingClose: signal.underlyingClose,
    optionInstrumentKey: signal.optionInstrumentKey, optionExpiry: selection.expiry ?? null, selectedStrike: selection.strikePrice ?? null, optionCandleCountLoaded: adapted.length,
    entryCandleTimestamp: entryCandle?.candleTime.toISOString() ?? null, entryCandleTimestampIst: entryCandle ? istTimestamp(entryCandle.candleTime) : null, outcome: outcome.exitReason, exitTimestamp: outcome.exitTimestamp?.toISOString() ?? null, exitTimestampIst: outcome.exitTimestamp ? istTimestamp(outcome.exitTimestamp) : null,
    entryPremium: outcome.entryPremium, exitPremium: outcome.exitPremium, returnPercent: outcome.premiumChangePercent, ambiguous: outcome.ambiguous, unavailable: outcome.unavailable,
    networkRequests: NETWORK_REQUESTS, cacheWrites: CACHE_WRITES,
  };
}

function selectContract(selections: Map<string, ContractSelection[]>, direction: 'CE' | 'PE', date: string, completedAt: Date): ContractSelection | undefined {
  const candidates = (selections.get(`${direction}|${date}`) ?? [])
    .filter((contract) => new Date(contract.timestamp).getTime() <= completedAt.getTime())
    .sort((left, right) => new Date(right.timestamp).getTime() - new Date(left.timestamp).getTime());
  return candidates[0] ?? selections.get(`${direction}|${date}`)?.[0];
}

function buildAtrMaps(sessions: readonly V9PreparedSession[]): Map<any, Map<number, number>> {
  const engine = new IndicatorEngineService(); const result = new Map<any, Map<number, number>>();
  for (const timeframe of [2, 3] as const) {
    const values = new Map<number, number>();
    sessions.forEach((session) => {
      const calculated = engine.calculate(session.frames[timeframe], { indicators: [{ type: IndicatorType.ATR, period: 14 }] });
      calculated.indicators.find((indicator: any) => indicator.config.type === IndicatorType.ATR)?.result.values.forEach((value: any) => {
        if ('value' in value && typeof value.value === 'number') values.set(value.timestamp.getTime(), value.value);
      });
    });
    result.set(timeframe, values);
  }
  return result;
}

function isCompleteSession(rows: readonly { timestamp: Date }[]): boolean {
  const sorted = [...rows].sort((left, right) => left.timestamp.getTime() - right.timestamp.getTime());
  return sorted.length === 375 && sorted.every((row, index) => index === 0 || row.timestamp.getTime() - sorted[index - 1].timestamp.getTime() === 60_000);
}

function istDate(value: Date): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(value).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function istTimestamp(value: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(value).replace(',', '');
}

void run().catch((error) => {
  console.error('V9 phase-2 smoke failed:', error instanceof Error ? error.stack ?? error.message : String(error));
  console.log('CE_SMOKE_FAIL');
  console.log('PE_SMOKE_FAIL');
  process.exitCode = 1;
});
