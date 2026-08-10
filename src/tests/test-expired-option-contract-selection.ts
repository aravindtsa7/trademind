import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import logger from '../core/logger/logger';
import HistoricalCandleRepository from '../modules/historical-candles/repositories/historical-candle.repository';
import UpstoxExpiredOptionClient from '../modules/options/client/upstox-expired-option.client';
import OptionContractSelectorService from '../modules/options/services/option-contract-selector.service';
import { OptionContract, OptionContractSelectionResult } from '../modules/options/types';
import { StrategySignal } from '../modules/strategies/dto/strategy-signal.dto';

dotenv.config();

const instrumentKey = 'NSE_INDEX|Nifty 50';
const timeframe = '1minute';
const signalTimestamp = new Date('2026-07-15T09:15:00+05:30');
const signalDayEnd = new Date('2026-07-15T15:29:59.999+05:30');
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
  const signalDate = getMarketDate(signalTimestamp);
  const nearestExpiry = expiries
    .filter((expiry) => expiry >= signalDate)
    .sort((left, right) => left.localeCompare(right))[0];

  if (!nearestExpiry) {
    throw new Error(`No Upstox expired expiry is available on or after ${signalDate}.`);
  }

  return nearestExpiry;
}

function assertSelection(
  result: OptionContractSelectionResult,
  signal: StrategySignal.BUY_CE | StrategySignal.BUY_PE,
  contracts: readonly OptionContract[],
  spotPrice: number
): void {
  const expectedOptionType = signal === StrategySignal.BUY_CE ? 'CE' : 'PE';
  const signalDate = getMarketDate(signalTimestamp);

  assert.equal(result.optionType, expectedOptionType);
  assert.ok(result.instrumentKey.length > 0, 'Selected option contract must contain an instrument key.');
  assert.ok(
    getMarketDate(result.expiry) >= signalDate,
    'Selected option expiry must not be before the signal date.'
  );

  const eligibleContracts = contracts.filter(
    (contract) =>
      contract.underlying === result.underlying &&
      contract.optionType === expectedOptionType &&
      getMarketDate(contract.expiry) === getMarketDate(result.expiry) &&
      Number.isFinite(contract.strikePrice) &&
      contract.strikePrice > 0
  );
  const expectedStrike = [...eligibleContracts].sort(
    (left, right) =>
      Math.abs(left.strikePrice - spotPrice) - Math.abs(right.strikePrice - spotPrice) ||
      left.strikePrice - right.strikePrice
  )[0]?.strikePrice;

  assert.equal(result.strikePrice, expectedStrike, 'Selected strike must be the nearest ATM strike.');
}

function printSelection(
  label: string,
  result: OptionContractSelectionResult,
  contracts: readonly OptionContract[]
): void {
  const contract = contracts.find((candidate) => candidate.instrumentKey === result.instrumentKey);
  console.log(`\n${label}`);
  console.log(`Signal timestamp: ${signalTimestamp.toISOString()}`);
  console.log(`NIFTY spot price: ${result.spotPrice}`);
  console.log(`Selected expiry: ${getMarketDate(result.expiry)}`);
  console.log(`Option type: ${result.optionType}`);
  console.log(`Strike price: ${result.strikePrice}`);
  console.log(`Lot size: ${contract?.lotSize ?? 'Unavailable'}`);
  console.log(`Trading symbol: ${result.tradingSymbol}`);
  console.log(`Instrument key: ${result.instrumentKey}`);
  console.log(`Strike distance: ${result.strikeDistance}`);
}

async function run(): Promise<void> {
  const accessToken = process.env.UPSTOX_ACCESS_TOKEN?.trim();
  if (!accessToken) {
    throw new Error('Set UPSTOX_ACCESS_TOKEN in .env before running this integration test.');
  }

  const candleRepository = new HistoricalCandleRepository();
  const client = new UpstoxExpiredOptionClient(accessToken);
  const selector = new OptionContractSelectorService();

  logger.info('Starting expired option contract selection integration test', {
    instrumentKey,
    signalTimestamp,
  });

  const candles = await candleRepository.findRange(
    instrumentKey,
    timeframe,
    signalTimestamp,
    signalDayEnd
  );
  const signalCandle = candles.find(
    (candle) => candle.candleTime.getTime() === signalTimestamp.getTime()
  );
  if (!signalCandle) {
    throw new Error(`No stored NIFTY one-minute candle exists at ${signalTimestamp.toISOString()}.`);
  }

  const spotPrice = Number(signalCandle.close);
  if (!Number.isFinite(spotPrice) || spotPrice <= 0) {
    throw new Error('Stored NIFTY signal candle contains an invalid close price.');
  }

  const expiries = await client.fetchAvailableExpiries(instrumentKey);
  const expiryDate = getNearestAvailableExpiry(expiries);
  const contracts = await client.fetchExpiredOptionContracts(instrumentKey, expiryDate);
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

  assertSelection(ceSelection, StrategySignal.BUY_CE, contracts, spotPrice);
  assertSelection(peSelection, StrategySignal.BUY_PE, contracts, spotPrice);
  printSelection('BUY_CE selection', ceSelection, contracts);
  printSelection('BUY_PE selection', peSelection, contracts);

  logger.info('Expired option contract selection integration test completed', {
    instrumentKey,
    signalTimestamp,
    expiryDate,
    spotPrice,
    ceInstrumentKey: ceSelection.instrumentKey,
    peInstrumentKey: peSelection.instrumentKey,
  });
}

run().catch((error) => {
  logger.error('Expired option contract selection integration test failed', { error });
  console.error('Expired option contract selection integration test failed.', error);
  process.exitCode = 1;
});
