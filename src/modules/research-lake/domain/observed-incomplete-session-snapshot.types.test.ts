import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HistoricalAssetType } from './historical-asset.types';
import { CanonicalHistoricalCandle } from './canonical-historical-candle';
import { ManifestCandleContent } from './dataset-manifest.types';
import { SessionWindow } from './exchange-calendar.types';
import { HistoricalProviderId } from '../interfaces/historical-provider-capability.types';
import {
  buildObservedIncompleteSessionSnapshot,
  canonicalHistoricalCandleToManifestContent,
  computeObservedSnapshotContentChecksum,
  ObservedIncompleteSessionSnapshotContentPayload,
  ObservedIncompleteSessionSnapshotV1,
  readObservedIncompleteSessionSnapshot,
  storeObservedIncompleteSessionSnapshot,
} from './observed-incomplete-session-snapshot.types';

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'observed-snapshot-test-'));
}

const WINDOWS: readonly SessionWindow[] = [{ windowIndex: 0, openMinuteIst: 555, closeMinuteIst: 930 }];

function candleRow(candleTime: string, open: number): ManifestCandleContent {
  return { candleTime, open: String(open), high: String(open + 1), low: String(open - 1), close: String(open + 0.5), volume: '1000', openInterest: null };
}

function basePayload(overrides: Partial<ObservedIncompleteSessionSnapshotContentPayload> = {}): ObservedIncompleteSessionSnapshotContentPayload {
  return {
    schemaVersion: 1,
    qualificationSemanticsVersion: 1,
    identity: { providerId: HistoricalProviderId.UPSTOX, instrumentKey: 'NSE_INDEX|Nifty 50', timeframe: '1minute', tradingDate: '2022-03-07' },
    sessionWindows: WINDOWS,
    expectedMinuteCount: 375,
    observedRowCount: 2,
    rows: [candleRow('2022-03-07T03:45:00.000Z', 17000), candleRow('2022-03-07T03:46:00.000Z', 17001)],
    missingExpectedMinutesIst: [622, 623, 624],
    sourceRowsSemanticChecksum: 'a'.repeat(64),
    durableHistoricalEvidenceSemanticChecksum: 'b'.repeat(64),
    ...overrides,
  };
}

// ---- G: determinism ----

test('same qualified source => identical snapshot checksum', () => {
  const first = computeObservedSnapshotContentChecksum(basePayload());
  const second = computeObservedSnapshotContentChecksum(basePayload());
  assert.equal(first, second);
});

test('row order does not perturb the checksum -- rows are sorted before hashing', () => {
  const forward = basePayload();
  const reversed = basePayload({ rows: [...forward.rows].reverse() });
  assert.equal(computeObservedSnapshotContentChecksum(forward), computeObservedSnapshotContentChecksum(reversed));
});

test('changing one source value changes the checksum', () => {
  const base = computeObservedSnapshotContentChecksum(basePayload());
  const changed = computeObservedSnapshotContentChecksum(basePayload({ rows: [candleRow('2022-03-07T03:45:00.000Z', 99999), candleRow('2022-03-07T03:46:00.000Z', 17001)] }));
  assert.notEqual(base, changed);
});

test('changing missingExpectedMinutesIst changes the checksum', () => {
  const base = computeObservedSnapshotContentChecksum(basePayload());
  const changed = computeObservedSnapshotContentChecksum(basePayload({ missingExpectedMinutesIst: [700, 701, 702] }));
  assert.notEqual(base, changed);
});

test('changing durableHistoricalEvidenceSemanticChecksum changes the checksum', () => {
  const base = computeObservedSnapshotContentChecksum(basePayload());
  const changed = computeObservedSnapshotContentChecksum(basePayload({ durableHistoricalEvidenceSemanticChecksum: 'c'.repeat(64) }));
  assert.notEqual(base, changed);
});

test('buildObservedIncompleteSessionSnapshot attaches a checksum consistent with computeObservedSnapshotContentChecksum', () => {
  const snapshot = buildObservedIncompleteSessionSnapshot(basePayload());
  assert.equal(snapshot.snapshotContentChecksum, computeObservedSnapshotContentChecksum(basePayload()));
});

test('unstable metadata never enters the payload/checksum -- the type has no capturedAt/uuid/machine-path/git-revision field', () => {
  const snapshot = buildObservedIncompleteSessionSnapshot(basePayload());
  const keys = Object.keys(snapshot);
  for (const forbidden of ['capturedAt', 'retrievedAt', 'uuid', 'id', 'machinePath', 'gitRevision', 'processId', 'pid']) {
    assert.ok(!keys.includes(forbidden), `snapshot must never carry a '${forbidden}' field`);
  }
});

// ---- row mapping ----

test('canonicalHistoricalCandleToManifestContent normalizes number OHLC through the same Prisma.Decimal path canonical persistence uses', () => {
  const candle: CanonicalHistoricalCandle = {
    assetType: HistoricalAssetType.NIFTY_INDEX,
    instrumentKey: 'NSE_INDEX|Nifty 50',
    candleTime: new Date('2022-03-07T03:45:00.000Z'),
    open: 17000.5,
    high: 17001,
    low: 16999.25,
    close: 17000.75,
    volume: 1234n,
    openInterest: null,
  };
  const content = canonicalHistoricalCandleToManifestContent(candle);
  assert.equal(content.candleTime, '2022-03-07T03:45:00.000Z');
  assert.equal(content.open, '17000.5');
  assert.equal(content.high, '17001');
  assert.equal(content.low, '16999.25');
  assert.equal(content.close, '17000.75');
  assert.equal(content.volume, '1234');
  assert.equal(content.openInterest, null);
});

// ---- storage ----

test('storeObservedIncompleteSessionSnapshot + readObservedIncompleteSessionSnapshot round-trip', () => {
  const root = tempRoot();
  try {
    const snapshot: ObservedIncompleteSessionSnapshotV1 = buildObservedIncompleteSessionSnapshot(basePayload());
    const stored = storeObservedIncompleteSessionSnapshot(root, snapshot);
    assert.equal(stored.wasNewlyWritten, true);
    const readBack = readObservedIncompleteSessionSnapshot(root, snapshot.snapshotContentChecksum);
    assert.deepEqual(readBack, snapshot);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('storing the identical snapshot twice is an idempotent, verified skip', () => {
  const root = tempRoot();
  try {
    const snapshot = buildObservedIncompleteSessionSnapshot(basePayload());
    const first = storeObservedIncompleteSessionSnapshot(root, snapshot);
    const second = storeObservedIncompleteSessionSnapshot(root, snapshot);
    assert.equal(first.wasNewlyWritten, true);
    assert.equal(second.wasNewlyWritten, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
