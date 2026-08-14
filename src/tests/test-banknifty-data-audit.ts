import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import logger from '../core/logger/logger';
import HistoricalCandleRepository from '../modules/historical-candles/repositories/historical-candle.repository';
import InstrumentRepository from '../modules/instruments/repositories/instrument.repository';
import UpstoxExpiredOptionClient from '../modules/options/client/upstox-expired-option.client';
import { OptionContract } from '../modules/options/types';
import { auditBankNiftyUnderlying, proposedSplit, calendarWeekdays } from '../modules/research/banknifty-data-audit';

logger.silent = true;
const instrumentKey = 'NSE_INDEX|Nifty Bank';
const startDate = '2026-03-02';
const endDate = '2026-08-04';
const auditDirectory = resolve(process.cwd(), 'artifacts', 'banknifty-data-audit');

async function run(): Promise<void> {
  const candleRepository = new HistoricalCandleRepository();
  const instrumentRepository = new InstrumentRepository();
  const metadataRows = await instrumentRepository.findAll({ underlyingSymbol: 'BANKNIFTY' });
  const underlyingRows = await candleRepository.findByInstrumentAndTimeframe(instrumentKey, '1minute');
  const mappedRows = underlyingRows.map((row) => ({ instrumentKey: row.instrumentKey, timeframe: row.timeframe, candleTime: new Date(row.candleTime.getTime()), open: Number(row.open), high: Number(row.high), low: Number(row.low), close: Number(row.close) }));
  const underlyingAudit = auditBankNiftyUnderlying(mappedRows, instrumentKey, '1minute', startDate, endDate);
  const network = { expiredOptionMetadataRequests: 0, optionCandleRequests: 0 };
  const metadata = await fetchMetadata(network);
  const localOption = await localOptionCoverage();
  const split = proposedSplit(underlyingAudit.datesWithData.filter((date) => underlyingAudit.sessions.find((session) => session.tradingDate === date)?.complete));
  const summary = {
    instrument: { requestedName: 'BANK NIFTY', exactInstrumentKey: instrumentKey, keySource: 'existing project-supported index key; no BANK NIFTY index row exists in Instrument metadata table', derivativeMetadataRows: metadataRows.length, derivativeInstrumentTypes: [...new Set(metadataRows.map((row) => row.instrumentType))].sort(), derivativeDateRange: metadataRows.length ? { earliest: new Date(Math.min(...metadataRows.map((row) => row.expiry.getTime()))).toISOString(), latest: new Date(Math.max(...metadataRows.map((row) => row.expiry.getTime()))).toISOString() } : null },
    auditPeriod: { startDate, endDate, currentSessionExcluded: '2026-08-13', outcomesEvaluated: false, finalHoldoutAccessed: false },
    underlying: underlyingAudit,
    optionsMetadata: metadata,
    optionCandleCoverage: { ...localOption, representativeSelectionSemantics: 'ATM nearest non-expired expiry, then minimum strike distance with existing deterministic tie-breaks', requiredRepresentativeSessions: 0, completeLocally: 0, missingLocally: 0, incompleteLocally: 0, status: underlyingAudit.cleanSessionCount > 0 ? 'REQUIRES_REPRESENTATIVE_SELECTION_AUDIT' : 'NOT_ESTIMABLE_NO_USABLE_UNDERLYING_SESSIONS', upstoxOptionCandleDownloads: 0 },
    proposedProtectedSplit: split,
    networkRequestCount: network,
    verdict: verdict(underlyingAudit, metadata),
  };
  mkdirSync(auditDirectory, { recursive: true });
  write('underlying-audit.json', underlyingAudit);
  write('option-metadata-audit.json', metadata);
  write('option-coverage-audit.json', summary.optionCandleCoverage);
  write('research-split-proposal.json', split);
  write('audit-summary.json', summary);
  console.log(JSON.stringify({ exactInstrumentKey: instrumentKey, usableSessions: underlyingAudit.cleanSessionCount, totalSessionDates: underlyingAudit.totalSessionDates, cleanSessionPercentage: underlyingAudit.totalSessionDates ? underlyingAudit.cleanSessionCount / underlyingAudit.totalSessionDates * 100 : 0, optionExpiryCount: metadata.availableExpiryCount, optionCandleDownloads: 0, networkRequestCount: network, proposedSplitStatus: split.status, verdict: summary.verdict, artifacts: auditDirectory }, null, 2));
}

async function fetchMetadata(network: { expiredOptionMetadataRequests: number; optionCandleRequests: number }) {
  const token = process.env.UPSTOX_ACCESS_TOKEN?.trim();
  if (!token) return { status: 'NOT_QUERIED_NO_UPSTOX_ACCESS_TOKEN', availableExpiryCount: 0, earliestExpiry: null, latestExpiry: null, expiries: [], contractsFetched: 0, contractCountsByExpiry: {}, ceContracts: 0, peContracts: 0, strikeSpacing: [], weeklyExpiryCount: 0, monthlyExpiryCount: 0, missingMetadataByTradingDate: [], conventionNotes: ['No option-candle requests were made.'] };
  try {
    const client = new UpstoxExpiredOptionClient(token);
    network.expiredOptionMetadataRequests += 1;
    const allExpiries = (await client.fetchAvailableExpiries(instrumentKey)).sort();
    const relevant = allExpiries.filter((expiry) => expiry >= startDate && expiry <= '2026-08-06');
    const contractRows: Array<{ expiry: string; contracts: OptionContract[] }> = [];
    for (const expiry of relevant) { network.expiredOptionMetadataRequests += 1; contractRows.push({ expiry, contracts: await client.fetchExpiredOptionContracts(instrumentKey, expiry) }); }
    const contracts = contractRows.flatMap((row) => row.contracts);
    const strikes = [...new Set(contracts.map((contract) => contract.strikePrice))].sort((left, right) => left - right);
    const spacing = [...new Set(strikes.slice(1).map((strike, index) => strike - strikes[index]))].sort((left, right) => left - right);
    const missingMetadataByTradingDate = calendarWeekdays(startDate, endDate).filter((date) => !allExpiries.some((expiry) => expiry >= date));
    return { status: 'QUERIED_METADATA_ONLY', availableExpiryCount: allExpiries.length, earliestExpiry: allExpiries[0] ?? null, latestExpiry: allExpiries.at(-1) ?? null, expiries: relevant, contractsFetched: contracts.length, contractCountsByExpiry: Object.fromEntries(contractRows.map((row) => [row.expiry, row.contracts.length])), ceContracts: contracts.filter((contract) => contract.optionType === 'CE').length, peContracts: contracts.filter((contract) => contract.optionType === 'PE').length, strikeSpacing: spacing, weeklyExpiryCount: relevant.filter((expiry) => isLikelyWeekly(expiry)).length, monthlyExpiryCount: relevant.filter((expiry) => !isLikelyWeekly(expiry)).length, missingMetadataByTradingDate, conventionNotes: ['Expiry and contract metadata only; no option candles fetched.', 'No expiry on or after 2026-07-29 is currently returned by the authoritative expired-option metadata source.'] };
  } catch (error) {
    return { status: 'METADATA_QUERY_FAILED', availableExpiryCount: 0, earliestExpiry: null, latestExpiry: null, expiries: [], contractsFetched: 0, contractCountsByExpiry: {}, ceContracts: 0, peContracts: 0, strikeSpacing: [], weeklyExpiryCount: 0, monthlyExpiryCount: 0, missingMetadataByTradingDate: [], error: error instanceof Error ? error.message : String(error), conventionNotes: ['No option candles were fetched.'] };
  }
}

async function localOptionCoverage() {
  const prisma = new PrismaClient();
  try {
    const count = await prisma.historicalOptionCandle.count({ where: { tradingSymbol: { startsWith: 'BANKNIFTY' } } });
    const instruments = await prisma.historicalOptionCandle.findMany({ where: { tradingSymbol: { startsWith: 'BANKNIFTY' } }, distinct: ['instrumentKey'], select: { instrumentKey: true } });
    return { localBankNiftyOptionRowsByTradingSymbol: count, localBankNiftyOptionInstrumentCount: instruments.length, localBankNiftyOptionInstrumentKeysSample: instruments.slice(0, 20).map((row) => row.instrumentKey), candleCountDistribution: count ? 'not expanded because no representative underlying sessions exist' : { '0': 0 } };
  } finally { await prisma.$disconnect(); }
}

function isLikelyWeekly(expiry: string): boolean { const date = new Date(`${expiry}T00:00:00Z`); return date.getUTCDate() < 24; }
function verdict(underlying: { cleanSessionCount: number }, metadata: { status: string; availableExpiryCount: number }): 'READY_FOR_RESEARCH' | 'READY_WITH_LIMITATIONS' | 'NOT_READY_FOR_RESEARCH' { if (underlying.cleanSessionCount === 0) return 'NOT_READY_FOR_RESEARCH'; if (metadata.status !== 'QUERIED_METADATA_ONLY' || metadata.availableExpiryCount === 0) return 'READY_WITH_LIMITATIONS'; return 'READY_FOR_RESEARCH'; }
function write(name: string, value: unknown): void { writeFileSync(resolve(auditDirectory, name), `${JSON.stringify(value, null, 2)}\n`, 'utf8'); }

void run().catch((error) => { console.error('BANK NIFTY data audit failed:', error); process.exitCode = 1; });
