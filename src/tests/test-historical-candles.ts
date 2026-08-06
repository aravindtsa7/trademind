import dotenv from 'dotenv';
import logger from '../core/logger/logger';
import HistoricalCandleRepository from '../modules/historical-candles/repositories/historical-candle.repository';
import HistoricalCandleSyncService from '../modules/historical-candles/services/historical-candle-sync.service';
import InstrumentRepository from '../modules/instruments/repositories/instrument.repository';

dotenv.config();

const oneMinuteTimeframe = '1minute';

function getPreviousWeekday(): string {
  const date = new Date();

  do {
    date.setDate(date.getDate() - 1);
  } while (date.getDay() === 0 || date.getDay() === 6);

  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));

  return `${values.year}-${values.month}-${values.day}`;
}

async function run(): Promise<void> {
  const accessToken = process.env.UPSTOX_ACCESS_TOKEN?.trim();
  if (!accessToken) {
    throw new Error('Set UPSTOX_ACCESS_TOKEN in .env before running this integration test.');
  }

  const instrumentRepository = new InstrumentRepository();
  const historicalCandleRepository = new HistoricalCandleRepository();
  const historicalCandleSyncService = new HistoricalCandleSyncService();
  const instrument = (await instrumentRepository.findActive())[0];

  if (!instrument) {
    throw new Error('No active instrument is available for the historical candle integration test.');
  }

  const syncDate = getPreviousWeekday();
  logger.info('Starting historical candle integration test', {
    instrumentKey: instrument.instrumentKey,
    syncDate,
  });

  const summary = await historicalCandleSyncService.sync(
    instrument.instrumentKey,
    syncDate,
    syncDate
  );
  const totalCandleCount = await historicalCandleRepository.count({
    instrumentKey: instrument.instrumentKey,
    timeframe: oneMinuteTimeframe,
  });
  const latestCandle = await historicalCandleRepository.findLatest(
    instrument.instrumentKey,
    oneMinuteTimeframe
  );

  console.log(`Instrument key: ${summary.instrumentKey}`);
  console.log(`Downloaded: ${summary.downloaded}`);
  console.log(`Inserted: ${summary.inserted}`);
  console.log(`Updated: ${summary.updated}`);
  console.log(`Duration: ${summary.durationMs} ms`);
  console.log(`Total candle count: ${totalCandleCount}`);
  console.log(`Latest candle time: ${latestCandle?.candleTime.toISOString() ?? '-'}`);

  logger.info('Historical candle integration test completed', {
    instrumentKey: summary.instrumentKey,
    downloaded: summary.downloaded,
    inserted: summary.inserted,
    updated: summary.updated,
    durationMs: summary.durationMs,
    totalCandleCount,
  });
}

run().catch((error) => {
  logger.error('Historical candle integration test failed', { error });
  console.error('Historical candle integration test failed.', error);
  process.exitCode = 1;
});
