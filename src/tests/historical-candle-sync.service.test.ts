import assert from 'node:assert/strict';
import test from 'node:test';
import HistoricalCandleSyncService from '../modules/historical-candles/services/historical-candle-sync.service';

const instrumentKey = 'NSE_INDEX|Nifty 50';
const timeframe = '1minute';

interface RangeCall {
  instrumentKey: string;
  toDate: string;
  fromDate: string;
}

interface StoredCandle {
  candleTime: Date;
}

class HistoricalCandleRepositoryMock {
  readonly rangeCalls: Array<{
    instrumentKey: string;
    timeframe: string;
    startTime: Date;
    endTime: Date;
  }> = [];

  constructor(private readonly candles: StoredCandle[]) {}

  async createSyncLog(): Promise<{ id: string }> {
    return { id: 'sync-log-id' };
  }

  async findRange(
    requestedInstrumentKey: string,
    requestedTimeframe: string,
    startTime: Date,
    endTime: Date
  ): Promise<StoredCandle[]> {
    this.rangeCalls.push({
      instrumentKey: requestedInstrumentKey,
      timeframe: requestedTimeframe,
      startTime,
      endTime,
    });

    return this.candles.filter(
      (candle) => candle.candleTime >= startTime && candle.candleTime <= endTime
    );
  }

  async bulkUpsert(): Promise<[]> {
    return [];
  }

  async updateSyncLog(): Promise<{ id: string }> {
    return { id: 'sync-log-id' };
  }
}

class UpstoxHistoricalClientMock {
  readonly calls: RangeCall[] = [];

  async fetchOneMinuteCandles(
    requestedInstrumentKey: string,
    toDate: string,
    fromDate: string
  ): Promise<[]> {
    this.calls.push({ instrumentKey: requestedInstrumentKey, toDate, fromDate });

    return [];
  }
}

function createStoredCandle(date: string): StoredCandle {
  return { candleTime: new Date(`${date}T09:15:00+05:30`) };
}

function createService(candles: StoredCandle[]): {
  service: HistoricalCandleSyncService;
  repository: HistoricalCandleRepositoryMock;
  client: UpstoxHistoricalClientMock;
} {
  const service = new HistoricalCandleSyncService();
  const repository = new HistoricalCandleRepositoryMock(candles);
  const client = new UpstoxHistoricalClientMock();
  const dependencies = service as unknown as {
    repository: HistoricalCandleRepositoryMock;
    client: UpstoxHistoricalClientMock;
  };

  dependencies.repository = repository;
  dependencies.client = client;

  return { service, repository, client };
}

test('synchronizes the entire requested range when the database is empty', async () => {
  const { service, client } = createService([]);

  await service.sync(instrumentKey, '2026-07-10', '2026-08-05');

  assert.deepEqual(client.calls, [
    { instrumentKey, fromDate: '2026-07-10', toDate: '2026-08-05' },
  ]);
});

test('backfills the missing leading range when only the last requested day exists', async () => {
  const { service, client } = createService([createStoredCandle('2026-08-05')]);

  await service.sync(instrumentKey, '2026-07-10', '2026-08-05');

  assert.deepEqual(client.calls, [
    { instrumentKey, fromDate: '2026-07-10', toDate: '2026-08-04' },
  ]);
});

test('does not redownload a range whose stored coverage spans the request', async () => {
  const { service, client } = createService([
    createStoredCandle('2026-07-10'),
    createStoredCandle('2026-08-05'),
  ]);

  await service.sync(instrumentKey, '2026-07-10', '2026-08-05');

  assert.deepEqual(client.calls, []);
});

test('synchronizes only the newer trailing range for forward incremental coverage', async () => {
  const { service, client } = createService([
    createStoredCandle('2026-07-10'),
    createStoredCandle('2026-08-05'),
  ]);

  await service.sync(instrumentKey, '2026-07-10', '2026-08-07');

  assert.deepEqual(client.calls, [
    { instrumentKey, fromDate: '2026-08-06', toDate: '2026-08-07' },
  ]);
});

test('synchronizes both leading and trailing ranges around existing middle coverage', async () => {
  const { service, client } = createService([
    createStoredCandle('2026-07-20'),
    createStoredCandle('2026-07-25'),
  ]);

  await service.sync(instrumentKey, '2026-07-10', '2026-08-05');

  assert.deepEqual(client.calls, [
    { instrumentKey, fromDate: '2026-07-10', toDate: '2026-07-19' },
    { instrumentKey, fromDate: '2026-07-26', toDate: '2026-08-05' },
  ]);
});

test('synchronizes the full request when it is outside existing coverage', async () => {
  const { service, client } = createService([createStoredCandle('2026-08-05')]);

  await service.sync(instrumentKey, '2026-07-10', '2026-07-11');

  assert.deepEqual(client.calls, [
    { instrumentKey, fromDate: '2026-07-10', toDate: '2026-07-11' },
  ]);
});

test('uses the requested instrument and one-minute timeframe for the coverage lookup', async () => {
  const { service, repository } = createService([]);

  await service.sync(instrumentKey, '2026-07-10', '2026-08-05');

  assert.equal(repository.rangeCalls.length, 1);
  assert.equal(repository.rangeCalls[0].instrumentKey, instrumentKey);
  assert.equal(repository.rangeCalls[0].timeframe, timeframe);
  assert.equal(repository.rangeCalls[0].startTime.toISOString(), '2026-07-09T18:30:00.000Z');
  assert.equal(repository.rangeCalls[0].endTime.toISOString(), '2026-08-05T18:29:59.999Z');
});
