import assert from 'node:assert/strict';
import test from 'node:test';
import HistoricalCandleSyncService, {
  HistoricalCandleReconciliationIncompleteError,
} from '../modules/historical-candles/services/historical-candle-sync.service';

const instrumentKey = 'NSE_INDEX|Nifty 50';

interface StoredCandle {
  candleTime: Date;
}

function partialDayStored(date: string, rowCount: number): StoredCandle[] {
  const start = new Date(`${date}T09:15:00+05:30`).getTime();
  return Array.from({ length: rowCount }, (_, i) => ({ candleTime: new Date(start + i * 60_000) }));
}

/** Reproduces the real 2026-08-21 shape: 283 stored rows, and the broker returning the same 283 (no new data), so post-fetch verification is still incomplete and the real ~192-char message is thrown. */
class RepositoryMock {
  candles: StoredCandle[];
  readonly updateSyncLogCalls: Array<Record<string, unknown>> = [];
  private readonly updateSyncLogBehavior: (data: Record<string, unknown>) => Promise<{ id: string }>;

  constructor(initial: StoredCandle[], updateSyncLogBehavior?: (data: Record<string, unknown>) => Promise<{ id: string }>) {
    this.candles = [...initial];
    this.updateSyncLogBehavior = updateSyncLogBehavior ?? (async () => ({ id: 'log-1' }));
  }

  async createSyncLog() {
    return { id: 'log-1' };
  }

  async updateSyncLog(_id: string, data: Record<string, unknown>) {
    this.updateSyncLogCalls.push(data);
    return this.updateSyncLogBehavior(data);
  }

  async findRange(_ik: string, _tf: string, start: Date, end: Date) {
    return this.candles.filter((c) => c.candleTime >= start && c.candleTime <= end).sort((a, b) => a.candleTime.getTime() - b.candleTime.getTime());
  }

  async bulkUpsert(inputs: { create: { candleTime: Date } }[]) {
    for (const input of inputs) {
      this.candles = this.candles.filter((c) => c.candleTime.getTime() !== input.create.candleTime.getTime());
      this.candles.push({ candleTime: input.create.candleTime });
    }
    return [];
  }
}

class ClientMock {
  constructor(private readonly rowCount: number) {}
  async fetchOneMinuteCandles(_ik: string, _to: string, fromDate: string) {
    return partialDayStored(fromDate, this.rowCount).map((c) => ({
      candleTime: c.candleTime,
      open: 100,
      high: 101,
      low: 99,
      close: 100.5,
      volume: 1000n,
    }));
  }
}

function createService(
  updateSyncLogBehavior?: (data: Record<string, unknown>) => Promise<{ id: string }>
): { service: HistoricalCandleSyncService; repository: RepositoryMock } {
  const service = new HistoricalCandleSyncService();
  const repository = new RepositoryMock(partialDayStored('2026-08-21', 283), updateSyncLogBehavior);
  const client = new ClientMock(283); // broker returns the same 283 rows again -> still incomplete after fetch
  const dependencies = service as unknown as { repository: RepositoryMock; client: ClientMock };
  dependencies.repository = repository;
  dependencies.client = client;
  return { service, repository };
}

// C: original reconciliation error still propagates to the caller after the FAILED log write succeeds.
test('C: the original HistoricalCandleReconciliationIncompleteError still reaches the caller after a successful FAILED log write', async () => {
  const { service, repository } = createService(); // updateSyncLog succeeds (post-fix behavior)
  let thrownMessage: string | undefined;

  await assert.rejects(
    () => service.sync(instrumentKey, '2026-08-21', '2026-08-21', { tradingDates: ['2026-08-21'] }),
    (error: unknown) => {
      assert.ok(error instanceof HistoricalCandleReconciliationIncompleteError);
      assert.match(error.message, /2026-08-21/);
      assert.equal(error.message.length, 192); // caller sees the FULL, untruncated original message
      thrownMessage = error.message;
      return true;
    }
  );

  // The service itself must not pre-truncate: normalization is the repository's
  // responsibility alone (see historical-candle-sync-log-write-boundary.test.ts),
  // so the service is expected to hand the repository the FULL, untruncated
  // message here -- this repository mock intentionally does not implement
  // normalization, which is exactly what proves the service isn't duplicating it.
  const failedCall = repository.updateSyncLogCalls.find((c) => c.status === 'FAILED');
  assert.ok(failedCall, 'expected a FAILED status update to have been attempted');
  assert.equal(failedCall!.errorMessage, thrownMessage);
});

// D: sync-log persistence itself throws for an unrelated DB reason -> original reconciliation error remains authoritative.
test('D: an unrelated DB failure while writing the FAILED log does not replace the original reconciliation error', async () => {
  const dbError = new Error('ECONNRESET: connection to MySQL lost');
  const { service, repository } = createService(async () => {
    throw dbError;
  });

  await assert.rejects(
    () => service.sync(instrumentKey, '2026-08-21', '2026-08-21', { tradingDates: ['2026-08-21'] }),
    (error: unknown) => {
      // The caller must see the ORIGINAL reconciliation failure, never the secondary log-write failure.
      assert.ok(error instanceof HistoricalCandleReconciliationIncompleteError);
      assert.notEqual(error, dbError);
      return true;
    }
  );

  // The log write was attempted (and failed) -- proving the failure was contained per the
  // service's existing swallow-and-log policy, not silently skipped or left unattempted.
  assert.equal(repository.updateSyncLogCalls.length, 1);
  assert.equal(repository.updateSyncLogCalls[0].status, 'FAILED');
});

// E: the success path is unaffected by this fix.
test('E: a normal COMPLETED sync is unaffected (no errorMessage ever set, no truncation logic engaged)', async () => {
  const service = new HistoricalCandleSyncService();
  const repository = new RepositoryMock(partialDayStored('2026-08-21', 375)); // already complete
  const client = new ClientMock(375);
  const dependencies = service as unknown as { repository: RepositoryMock; client: ClientMock };
  dependencies.repository = repository;
  dependencies.client = client;

  const summary = await service.sync(instrumentKey, '2026-08-21', '2026-08-21', { tradingDates: ['2026-08-21'] });

  assert.deepEqual(summary.skippedCompleteDates, ['2026-08-21']);
  const completedCall = repository.updateSyncLogCalls.find((c) => c.status === 'COMPLETED');
  assert.ok(completedCall);
  assert.equal('errorMessage' in completedCall!, false);
});
