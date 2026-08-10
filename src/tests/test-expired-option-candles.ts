import dotenv from 'dotenv';
import logger from '../core/logger/logger';
import HistoricalCandleRepository from '../modules/historical-candles/repositories/historical-candle.repository';
import UpstoxExpiredOptionCandleClient from '../modules/options/client/upstox-expired-option-candle.client';
import UpstoxExpiredOptionClient from '../modules/options/client/upstox-expired-option.client';
import { ExpiredOptionCandleDto } from '../modules/options/dto/upstox-expired-option-candle.dto';
import OptionContractSelectorService from '../modules/options/services/option-contract-selector.service';
import { OptionContract, OptionContractSelectionResult } from '../modules/options/types';
import { StrategySignal } from '../modules/strategies/dto/strategy-signal.dto';

dotenv.config();

const instrumentKey = 'NSE_INDEX|Nifty 50';
const timeframe = '1minute';
const signalDate = '2026-07-15';
const signalTimestamp = new Date(`${signalDate}T09:15:00+05:30`);
const signalDayEnd = new Date(`${signalDate}T15:29:59.999+05:30`);
const marketDateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Kolkata',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function getMarketDate(date: Date): string {
  const values = Object.fromEntries(
    marketDateFormatter.formatToParts(date).map((part) => [part.type, part.value])
  );

  return `${values.year}-${values.month}-${values.day}`;
}

function getNearestAvailableExpiry(expiries: readonly string[]): string {
  const nearestExpiry = expiries
    .filter((expiry) => expiry >= signalDate)
    .sort((left, right) => left.localeCompare(right))[0];

  if (!nearestExpiry) {
    throw new Error(`No Upstox expired expiry is available on or after ${signalDate}.`);
  }

  return nearestExpiry;
}

function getCandleAt(
  candles: readonly ExpiredOptionCandleDto[],
  timestamp: Date,
  label: string
): ExpiredOptionCandleDto {
  const candle = candles.find((candidate) => candidate.candleTime.getTime() === timestamp.getTime());
  if (!candle) {
    throw new Error(`${label} has no option candle aligned to ${timestamp.toISOString()}.`);
  }

  return candle;
}

function printContractSession(
  label: string,
  selection: OptionContractSelectionResult,
  candles: readonly ExpiredOptionCandleDto[]
): void {
  const chronologicalCandles = [...candles].sort(
    (left, right) => left.candleTime.getTime() - right.candleTime.getTime()
  );
  const first = chronologicalCandles[0];
  const last = chronologicalCandles[chronologicalCandles.length - 1];
  const sessionHigh = Math.max(...chronologicalCandles.map((candle) => candle.high));
  const sessionLow = Math.min(...chronologicalCandles.map((candle) => candle.low));
  const totalVolume = chronologicalCandles.reduce((sum, candle) => sum + candle.volume, 0n);

  console.log(`\n${label} session`);
  console.log(`Instrument key: ${selection.instrumentKey}`);
  console.log(`Trading symbol: ${selection.tradingSymbol}`);
  console.log(`Expiry: ${getMarketDate(selection.expiry)}`);
  console.log(`Strike: ${selection.strikePrice}`);
  console.log(`Candle count: ${chronologicalCandles.length}`);
  console.log(`First candle time: ${first.candleTime.toISOString()}`);
  console.log(`Last candle time: ${last.candleTime.toISOString()}`);
  console.log(`First open: ${first.open}`);
  console.log(`First close: ${first.close}`);
  console.log(`Session high: ${sessionHigh}`);
  console.log(`Session low: ${sessionLow}`);
  console.log(`Last close: ${last.close}`);
  console.log(`Total volume: ${totalVolume.toString()}`);
}

function printSignalPremiums(label: string, candles: readonly ExpiredOptionCandleDto[]): void {
  const horizons = [0, 5, 15, 30, 60];
  const premiums = horizons.map((minutes) => {
    const timestamp = new Date(signalTimestamp.getTime() + minutes * 60_000);
    const candle = getCandleAt(candles, timestamp, label);

    return { minutes, premium: candle.close };
  });

  console.log(`\n${label} premium alignment`);
  console.log(`Signal timestamp: ${signalTimestamp.toISOString()}`);
  premiums.forEach(({ minutes, premium }) => {
    const labelText = minutes === 0 ? 'Premium at signal time' : `Premium ${minutes} minutes later`;
    console.log(`${labelText}: ${premium}`);
  });
}

async function run(): Promise<void> {
  const accessToken = process.env.UPSTOX_ACCESS_TOKEN?.trim();
  if (!accessToken) {
    throw new Error('Set UPSTOX_ACCESS_TOKEN in .env before running this integration test.');
  }

  const candleRepository = new HistoricalCandleRepository();
  const expiredOptionClient = new UpstoxExpiredOptionClient(accessToken);
  const expiredOptionCandleClient = new UpstoxExpiredOptionCandleClient(accessToken);
  const selector = new OptionContractSelectorService();

  logger.info('Starting expired option candle integration test', { instrumentKey, signalTimestamp });

  const spotCandles = await candleRepository.findRange(
    instrumentKey,
    timeframe,
    signalTimestamp,
    signalDayEnd
  );
  const signalSpotCandle = spotCandles.find(
    (candle) => candle.candleTime.getTime() === signalTimestamp.getTime()
  );
  if (!signalSpotCandle) {
    throw new Error(`No stored NIFTY one-minute candle exists at ${signalTimestamp.toISOString()}.`);
  }

  const spotPrice = Number(signalSpotCandle.close);
  if (!Number.isFinite(spotPrice) || spotPrice <= 0) {
    throw new Error('Stored NIFTY signal candle contains an invalid close price.');
  }

  const expiries = await expiredOptionClient.fetchAvailableExpiries(instrumentKey);
  const expiryDate = getNearestAvailableExpiry(expiries);
  const contracts = await expiredOptionClient.fetchExpiredOptionContracts(instrumentKey, expiryDate);
  const underlying = contracts[0]?.underlying;
  if (!underlying) {
    throw new Error('Upstox returned no usable underlying symbol for expired option contracts.');
  }

  const ceSelection = selector.select({
    underlying,
    spotPrice,
    signal: StrategySignal.BUY_CE,
    timestamp: signalTimestamp,
    contracts,
  });
  const peSelection = selector.select({
    underlying,
    spotPrice,
    signal: StrategySignal.BUY_PE,
    timestamp: signalTimestamp,
    contracts,
  });

  const [ceCandles, peCandles] = await Promise.all([
    expiredOptionCandleClient.fetchCandles(ceSelection.instrumentKey, signalDate, signalDate),
    expiredOptionCandleClient.fetchCandles(peSelection.instrumentKey, signalDate, signalDate),
  ]);

  printContractSession('BUY_CE', ceSelection, ceCandles);
  printSignalPremiums('BUY_CE', ceCandles);
  printContractSession('BUY_PE', peSelection, peCandles);
  printSignalPremiums('BUY_PE', peCandles);

  logger.info('Expired option candle integration test completed', {
    instrumentKey,
    signalTimestamp,
    spotPrice,
    expiryDate,
    ceInstrumentKey: ceSelection.instrumentKey,
    peInstrumentKey: peSelection.instrumentKey,
    ceCandleCount: ceCandles.length,
    peCandleCount: peCandles.length,
  });
}

run().catch((error) => {
  logger.error('Expired option candle integration test failed', { error });
  console.error('Expired option candle integration test failed.', error);
  process.exitCode = 1;
});
