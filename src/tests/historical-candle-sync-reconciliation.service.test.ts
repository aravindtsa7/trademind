import assert from 'node:assert/strict';
import test from 'node:test';
import HistoricalCandleSyncService, {
  HistoricalCandleReconciliationIncompleteError,
} from '../modules/historical-candles/services/historical-candle-sync.service';

const instrumentKey = 'NSE_INDEX|Nifty 50';

interface StoredCandle {
  candleTime: Date;
}

interface UpsertInput {
  create: { candleTime: Date } & Record<string, unknown>;
  update: Record<string, unknown>;
}

interface FetchCall {
  instrumentKey: string;
  toDate: string;
  fromDate: string;
}

/** Records every write-shaped call so tests can prove no duplicate/parallel persistence or delete path is ever used (scenario J). */
class HistoricalCandleRepositoryMock {
  candles: StoredCandle[] = [];
  readonly bulkUpsertCalls: UpsertInput[][] = [];
  readonly createCalls: unknown[] = [];
  readonly bulkCreateCalls: unknown[] = [];
  readonly deleteCalls: unknown[] = [];
  readonly syncLogUpdates: Array<Record<string, unknown>> = [];

  constructor(initial: StoredCandle[] = []) {
    this.candles = [...initial];
  }

  async createSyncLog(): Promise<{ id: string }> {
    return { id: 'sync-log-id' };
  }

  async updateSyncLog(_id: string, data: Record<string, unknown>): Promise<{ id: string }> {
    this.syncLogUpdates.push(data);
    return { id: 'sync-log-id' };
  }

  async findRange(_instrumentKey: string, _timeframe: string, startTime: Date, endTime: Date): Promise<StoredCandle[]> {
    return this.candles
      .filter((candle) => candle.candleTime >= startTime && candle.candleTime <= endTime)
      .sort((a, b) => a.candleTime.getTime() - b.candleTime.getTime());
  }

  async bulkUpsert(inputs: UpsertInput[]): Promise<StoredCandle[]> {
    this.bulkUpsertCalls.push(inputs);
    for (const input of inputs) {
      // Mirrors the real repository's unique-key semantics
      // (instrumentKey, timeframe, candleTime): a key can have at most one
      // row, so every existing row sharing this candleTime is replaced by
      // the single authoritative upserted row (not just the first match).
      this.candles = this.candles.filter(
        (candle) => candle.candleTime.getTime() !== input.create.candleTime.getTime()
      );
      this.candles.push({ candleTime: input.create.candleTime });
    }
    return inputs.map((input) => ({ candleTime: input.create.candleTime }));
  }

  async create(data: unknown): Promise<unknown> {
    this.createCalls.push(data);
    throw new Error('unexpected create() call: sync must reuse bulkUpsert, not a duplicate persistence path');
  }

  async bulkCreate(data: unknown): Promise<unknown> {
    this.bulkCreateCalls.push(data);
    throw new Error('unexpected bulkCreate() call: sync must reuse bulkUpsert, not a duplicate persistence path');
  }

  async deleteOlderThan(...args: unknown[]): Promise<unknown> {
    this.deleteCalls.push(args);
    throw new Error('unexpected delete call: reconciliation must never delete existing rows');
  }
}

interface MockBrokerCandle {
  candleTime: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: bigint;
  openInterest?: bigint;
}

/** Returns a configured response per requested date; defaults to empty (no data available). */
class UpstoxHistoricalClientMock {
  readonly calls: FetchCall[] = [];
  constructor(private readonly responsesByDate: Map<string, MockBrokerCandle[]> = new Map()) {}

  async fetchOneMinuteCandles(requestedInstrumentKey: string, toDate: string, fromDate: string): Promise<MockBrokerCandle[]> {
    this.calls.push({ instrumentKey: requestedInstrumentKey, toDate, fromDate });
    return this.responsesByDate.get(fromDate) ?? [];
  }
}

function fullDayBroker(date: string): MockBrokerCandle[] {
  const start = new Date(`${date}T09:15:00+05:30`).getTime();
  return Array.from({ length: 375 }, (_, index) => ({
    candleTime: new Date(start + index * 60_000),
    open: 100,
    high: 101,
    low: 99,
    close: 100.5,
    volume: 1000n,
  }));
}

function fullDayStored(date: string): StoredCandle[] {
  return fullDayBroker(date).map((candle) => ({ candleTime: candle.candleTime }));
}

function createService(
  storedCandles: StoredCandle[],
  responsesByDate: Map<string, MockBrokerCandle[]> = new Map()
): {
  service: HistoricalCandleSyncService;
  repository: HistoricalCandleRepositoryMock;
  client: UpstoxHistoricalClientMock;
} {
  const service = new HistoricalCandleSyncService();
  const repository = new HistoricalCandleRepositoryMock(storedCandles);
  const client = new UpstoxHistoricalClientMock(responsesByDate);
  const dependencies = service as unknown as {
    repository: HistoricalCandleRepositoryMock;
    client: UpstoxHistoricalClientMock;
  };
  dependencies.repository = repository;
  dependencies.client = client;
  return { service, repository, client };
}

// A: complete session -> no unnecessary broker fetch.
test('A: an already-complete 375-row session is skipped, not re-fetched', async () => {
  const { service, client } = createService(fullDayStored('2026-08-03'));

  const summary = await service.sync(instrumentKey, '2026-08-03', '2026-08-03', {
    tradingDates: ['2026-08-03'],
  });

  assert.deepEqual(client.calls, []);
  assert.deepEqual(summary.skippedCompleteDates, ['2026-08-03']);
  assert.deepEqual(summary.reconciledDates, []);
});

// B: completely missing known trading session -> fetch occurs -> 375 COMPLETE after readback.
test('B: a completely missing trading session is fetched and reconciled to 375 rows', async () => {
  const responses = new Map([['2026-08-11', fullDayBroker('2026-08-11')]]);
  const { service, client, repository } = createService([], responses);

  const summary = await service.sync(instrumentKey, '2026-08-10', '2026-08-21', {
    tradingDates: ['2026-08-11'],
  });

  assert.deepEqual(client.calls, [{ instrumentKey, fromDate: '2026-08-11', toDate: '2026-08-11' }]);
  assert.deepEqual(summary.reconciledDates, ['2026-08-11']);
  assert.equal(summary.inserted, 375);
  const persisted = repository.candles.filter((c) => c.candleTime.toISOString().startsWith('2026-08-11'));
  assert.equal(persisted.length, 375);
});

// C: partial trailing session, Aug-21 shape (283 rows, 09:15-13:57).
test('C: a partial trailing session (283 rows, Aug-21 shape) is reconciled to 375 COMPLETE', async () => {
  const stored = fullDayStored('2026-08-21').slice(0, 283);
  const responses = new Map([['2026-08-21', fullDayBroker('2026-08-21')]]);
  const { service, client, repository } = createService(stored, responses);

  const summary = await service.sync(instrumentKey, '2026-08-21', '2026-08-21', {
    tradingDates: ['2026-08-21'],
  });

  assert.deepEqual(client.calls, [{ instrumentKey, fromDate: '2026-08-21', toDate: '2026-08-21' }]);
  assert.deepEqual(summary.reconciledDates, ['2026-08-21']);
  assert.equal(summary.inserted, 92);
  assert.equal(summary.updated, 283);
  const persisted = repository.candles.filter((c) => c.candleTime.toISOString().startsWith('2026-08-21'));
  assert.equal(persisted.length, 375);
});

// D: partial Aug-18 shape (274 rows, 09:15-13:48) -- same behavior.
test('D: a partial session (274 rows, Aug-18 shape) is reconciled to 375 COMPLETE', async () => {
  const stored = fullDayStored('2026-08-18').slice(0, 274);
  const responses = new Map([['2026-08-18', fullDayBroker('2026-08-18')]]);
  const { service, repository } = createService(stored, responses);

  const summary = await service.sync(instrumentKey, '2026-08-18', '2026-08-18', {
    tradingDates: ['2026-08-18'],
  });

  assert.deepEqual(summary.reconciledDates, ['2026-08-18']);
  const persisted = repository.candles.filter((c) => c.candleTime.toISOString().startsWith('2026-08-18'));
  assert.equal(persisted.length, 375);
});

// E: interior one-minute gap (374 rows) -> incomplete and reconciled.
test('E: an interior one-minute gap (374 rows) is detected incomplete and reconciled', async () => {
  const stored = fullDayStored('2026-08-12');
  stored.splice(200, 1); // remove one interior minute; first/last/count-adjacent bookends alone would miss this
  const responses = new Map([['2026-08-12', fullDayBroker('2026-08-12')]]);
  const { service, client, repository } = createService(stored, responses);

  const summary = await service.sync(instrumentKey, '2026-08-12', '2026-08-12', {
    tradingDates: ['2026-08-12'],
  });

  assert.deepEqual(client.calls, [{ instrumentKey, fromDate: '2026-08-12', toDate: '2026-08-12' }]);
  assert.deepEqual(summary.reconciledDates, ['2026-08-12']);
  const persisted = repository.candles.filter((c) => c.candleTime.toISOString().startsWith('2026-08-12'));
  assert.equal(persisted.length, 375);
});

// F: duplicate/invalid stored session -> never accepted as complete without a fetch.
test('F: a stored session with a duplicate timestamp is never treated as complete', async () => {
  const stored = fullDayStored('2026-08-13');
  stored[374] = { candleTime: stored[373].candleTime }; // duplicate minute instead of the true last minute -> 375 rows but not complete
  const responses = new Map([['2026-08-13', fullDayBroker('2026-08-13')]]);
  const { service, client } = createService(stored, responses);

  const summary = await service.sync(instrumentKey, '2026-08-13', '2026-08-13', {
    tradingDates: ['2026-08-13'],
  });

  assert.deepEqual(client.calls, [{ instrumentKey, fromDate: '2026-08-13', toDate: '2026-08-13' }]);
  assert.deepEqual(summary.reconciledDates, ['2026-08-13']);
});

// G: broker still returns incomplete data -> FAILS CLOSED, never reports COMPLETED.
test('G: reconciliation fails closed if the broker response is still incomplete after fetch', async () => {
  const responses = new Map([['2026-08-14', fullDayBroker('2026-08-14').slice(0, 19)]]); // mirrors the real Aug-14 partial shape
  const { service, repository } = createService([], responses);

  await assert.rejects(
    () => service.sync(instrumentKey, '2026-08-14', '2026-08-14', { tradingDates: ['2026-08-14'] }),
    HistoricalCandleReconciliationIncompleteError
  );

  const lastLog = repository.syncLogUpdates.at(-1);
  assert.equal(lastLog?.status, 'FAILED');
  assert.match(String(lastLog?.errorMessage), /2026-08-14/);
});

// H: idempotent rerun -- after COMPLETE, a second reconciliation causes no destructive write/fetch.
test('H: rerunning reconciliation on an already-complete date performs no further fetch', async () => {
  const responses = new Map([['2026-08-17', fullDayBroker('2026-08-17')]]);
  const { service, client, repository } = createService(
    fullDayStored('2026-08-17').slice(0, 121),
    responses
  );

  const first = await service.sync(instrumentKey, '2026-08-17', '2026-08-17', { tradingDates: ['2026-08-17'] });
  assert.deepEqual(first.reconciledDates, ['2026-08-17']);
  assert.equal(client.calls.length, 1);
  const rowCountAfterFirst = repository.candles.length;

  const second = await service.sync(instrumentKey, '2026-08-17', '2026-08-17', { tradingDates: ['2026-08-17'] });
  assert.deepEqual(second.skippedCompleteDates, ['2026-08-17']);
  assert.deepEqual(second.reconciledDates, []);
  assert.equal(client.calls.length, 1); // no second fetch
  assert.equal(repository.candles.length, rowCountAfterFirst); // no destructive change
});

// I: multi-date input mixing COMPLETE / MISSING / PARTIAL -> only required dates reconciled.
test('I: a multi-date request only reconciles the non-complete dates', async () => {
  const stored = [
    ...fullDayStored('2026-08-03'), // COMPLETE
    ...fullDayStored('2026-08-12').slice(0, 258), // PARTIAL
    // 2026-08-10 MISSING (no rows at all)
  ];
  const responses = new Map([
    ['2026-08-12', fullDayBroker('2026-08-12')],
    ['2026-08-10', fullDayBroker('2026-08-10')],
  ]);
  const { service, client } = createService(stored, responses);

  const summary = await service.sync(instrumentKey, '2026-08-03', '2026-08-12', {
    tradingDates: ['2026-08-03', '2026-08-10', '2026-08-12'],
  });

  assert.deepEqual(
    client.calls.map((c) => c.fromDate).sort(),
    ['2026-08-10', '2026-08-12']
  );
  assert.deepEqual(summary.skippedCompleteDates, ['2026-08-03']);
  assert.deepEqual(summary.reconciledDates, ['2026-08-10', '2026-08-12']);
});

// J: proves the existing atomic HistoricalCandleRepository.bulkUpsert path is reused, not duplicated, and nothing is deleted.
test('J: reconciliation writes exclusively through bulkUpsert; no create/bulkCreate/delete path is used', async () => {
  const responses = new Map([['2026-08-19', fullDayBroker('2026-08-19')]]);
  const { service, repository } = createService([], responses);

  await service.sync(instrumentKey, '2026-08-19', '2026-08-19', { tradingDates: ['2026-08-19'] });

  assert.ok(repository.bulkUpsertCalls.length > 0);
  assert.equal(repository.createCalls.length, 0);
  assert.equal(repository.bulkCreateCalls.length, 0);
  assert.equal(repository.deleteCalls.length, 0);
  // Every write goes through the create/update upsert-input shape the atomic repository expects.
  for (const call of repository.bulkUpsertCalls) {
    for (const input of call) {
      assert.ok(input.create && typeof input.create === 'object');
      assert.ok(input.update && typeof input.update === 'object');
    }
  }
});

// Backward compatibility: omitting `options` leaves the existing bookend behavior untouched
// (mirrors "does not redownload a range whose stored coverage spans the request" in
// historical-candle-sync.service.test.ts).
test('omitting tradingDates preserves the existing bookend sync behavior', async () => {
  const { service, client } = createService([
    { candleTime: new Date('2026-07-10T03:45:00.000Z') },
    { candleTime: new Date('2026-08-05T03:45:00.000Z') },
  ]);

  await service.sync(instrumentKey, '2026-07-10', '2026-08-05');

  assert.deepEqual(client.calls, []); // unchanged: bookend coverage still reports nothing missing
});
