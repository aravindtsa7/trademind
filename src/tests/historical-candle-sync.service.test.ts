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

test('uses one chunk for a single-day missing range', async () => {
  const { service, client } = createService([]);

  await service.sync(instrumentKey, '2026-07-10', '2026-07-10');

  assert.deepEqual(client.calls, [
    { instrumentKey, fromDate: '2026-07-10', toDate: '2026-07-10' },
  ]);
});

test('uses one chunk for a missing range fully inside one month', async () => {
  const { service, client } = createService([]);

  await service.sync(instrumentKey, '2026-07-10', '2026-07-31');

  assert.deepEqual(client.calls, [
    { instrumentKey, fromDate: '2026-07-10', toDate: '2026-07-31' },
  ]);
});

test('splits a March 1 through July 9 range into five calendar-month chunks', async () => {
  const { service, client } = createService([]);

  await service.sync(instrumentKey, '2026-03-01', '2026-07-09');

  assert.deepEqual(client.calls, [
    { instrumentKey, fromDate: '2026-03-01', toDate: '2026-03-31' },
    { instrumentKey, fromDate: '2026-04-01', toDate: '2026-04-30' },
    { instrumentKey, fromDate: '2026-05-01', toDate: '2026-05-31' },
    { instrumentKey, fromDate: '2026-06-01', toDate: '2026-06-30' },
    { instrumentKey, fromDate: '2026-07-01', toDate: '2026-07-09' },
  ]);
});

test('handles partial first and last months without overlapping chunk boundaries', async () => {
  const { service, client } = createService([]);

  await service.sync(instrumentKey, '2026-03-15', '2026-04-10');

  assert.deepEqual(client.calls, [
    { instrumentKey, fromDate: '2026-03-15', toDate: '2026-03-31' },
    { instrumentKey, fromDate: '2026-04-01', toDate: '2026-04-10' },
  ]);
});

test('does not duplicate boundary dates between adjacent monthly chunks', async () => {
  const { service, client } = createService([]);

  await service.sync(instrumentKey, '2026-01-31', '2026-03-01');

  assert.deepEqual(client.calls, [
    { instrumentKey, fromDate: '2026-01-31', toDate: '2026-01-31' },
    { instrumentKey, fromDate: '2026-02-01', toDate: '2026-02-28' },
    { instrumentKey, fromDate: '2026-03-01', toDate: '2026-03-01' },
  ]);
  assert.equal(client.calls[0].toDate, '2026-01-31');
  assert.equal(client.calls[1].fromDate, '2026-02-01');
  assert.equal(client.calls[1].toDate, '2026-02-28');
  assert.equal(client.calls[2].fromDate, '2026-03-01');
});

test('splits ranges correctly across the December to January year boundary', async () => {
  const { service, client } = createService([]);

  await service.sync(instrumentKey, '2025-12-15', '2026-01-10');

  assert.deepEqual(client.calls, [
    { instrumentKey, fromDate: '2025-12-15', toDate: '2025-12-31' },
    { instrumentKey, fromDate: '2026-01-01', toDate: '2026-01-10' },
  ]);
});

test('chunks a leading backfill range before the existing coverage', async () => {
  const { service, client } = createService([createStoredCandle('2026-07-09')]);

  await service.sync(instrumentKey, '2026-03-01', '2026-07-09');

  assert.deepEqual(client.calls, [
    { instrumentKey, fromDate: '2026-03-01', toDate: '2026-03-31' },
    { instrumentKey, fromDate: '2026-04-01', toDate: '2026-04-30' },
    { instrumentKey, fromDate: '2026-05-01', toDate: '2026-05-31' },
    { instrumentKey, fromDate: '2026-06-01', toDate: '2026-06-30' },
    { instrumentKey, fromDate: '2026-07-01', toDate: '2026-07-08' },
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

test('chunks a trailing incremental range after the existing coverage', async () => {
  const { service, client } = createService([createStoredCandle('2026-07-10')]);

  await service.sync(instrumentKey, '2026-07-10', '2026-09-10');

  assert.deepEqual(client.calls, [
    { instrumentKey, fromDate: '2026-07-11', toDate: '2026-07-31' },
    { instrumentKey, fromDate: '2026-08-01', toDate: '2026-08-31' },
    { instrumentKey, fromDate: '2026-09-01', toDate: '2026-09-10' },
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
    { instrumentKey, fromDate: '2026-07-26', toDate: '2026-07-31' },
    { instrumentKey, fromDate: '2026-08-01', toDate: '2026-08-05' },
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
