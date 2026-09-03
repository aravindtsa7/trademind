import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildDerivedImputedResearchSession,
  computeDerivedImputedSessionChecksum,
  DerivedImputedResearchSessionContentPayload,
  DerivedImputedResearchSessionV1,
  DerivedResearchSessionRowV1,
  ImputationReason,
  readDerivedImputedResearchSession,
  ResearchRowProvenanceKind,
  ResearchSessionSourcePrecedenceTier,
  storeDerivedImputedResearchSession,
} from './derived-imputed-research-session.types';
import { HistoricalProviderId } from '../interfaces/historical-provider-capability.types';

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'derived-imputed-session-test-'));
}

function observedRow(candleTime: string, price: string): DerivedResearchSessionRowV1 {
  return {
    candleTime,
    open: price,
    high: price,
    low: price,
    close: price,
    volume: '1000',
    openInterest: null,
    availableAt: candleTime,
    provenance: { kind: ResearchRowProvenanceKind.OBSERVED, sourceSnapshotChecksum: 'a'.repeat(64) },
  };
}

function imputedRow(candleTime: string, price: string): DerivedResearchSessionRowV1 {
  return {
    candleTime,
    open: price,
    high: price,
    low: price,
    close: price,
    volume: '0',
    openInterest: null,
    availableAt: '2022-03-07T04:56:00.000Z',
    provenance: {
      kind: ResearchRowProvenanceKind.IMPUTED,
      method: 'LINEAR_BOUNDARY_INTERPOLATION',
      policyVersion: 1,
      authorizationId: 'NIFTY_2022_03_07_INDEX_GAP_V1',
      reason: ImputationReason.INDEX_BROADCAST_DATA_GAP,
      leftAnchor: { candleTime: '2022-03-07T04:51:00.000Z', field: 'CLOSE', contentChecksum: 'b'.repeat(64) },
      rightAnchor: { candleTime: '2022-03-07T04:55:00.000Z', field: 'OPEN', contentChecksum: 'c'.repeat(64) },
      sourceSnapshotChecksum: 'a'.repeat(64),
    },
  };
}

function basePayload(overrides: Partial<DerivedImputedResearchSessionContentPayload> = {}): DerivedImputedResearchSessionContentPayload {
  return {
    schemaVersion: 1,
    imputationSemanticsVersion: 1,
    identity: { instrumentKey: 'NSE_INDEX|Nifty 50', timeframe: '1minute', tradingDate: '2022-03-07' },
    authorizationId: 'NIFTY_2022_03_07_INDEX_GAP_V1',
    sourceSnapshotProviderId: HistoricalProviderId.UPSTOX,
    sourceSnapshotChecksum: 'a'.repeat(64),
    rows: [observedRow('2022-03-07T04:51:00.000Z', '100'), imputedRow('2022-03-07T04:52:00.000Z', '100.01'), observedRow('2022-03-07T04:55:00.000Z', '100.03')],
    realRowCount: 2,
    imputedRowCount: 1,
    precedenceTier: ResearchSessionSourcePrecedenceTier.AUTHORIZED_DERIVED_IMPUTED_SESSION,
    ...overrides,
  };
}

// ---- G: determinism ----

test('same source + same policy => identical derived checksum', () => {
  const first = computeDerivedImputedSessionChecksum(basePayload());
  const second = computeDerivedImputedSessionChecksum(basePayload());
  assert.equal(first, second);
});

test('changing one row (an OHLC value) changes the derived checksum', () => {
  const base = computeDerivedImputedSessionChecksum(basePayload());
  const changed = computeDerivedImputedSessionChecksum(
    basePayload({ rows: [observedRow('2022-03-07T04:51:00.000Z', '999'), imputedRow('2022-03-07T04:52:00.000Z', '100.01'), observedRow('2022-03-07T04:55:00.000Z', '100.03')] })
  );
  assert.notEqual(base, changed);
});

test('changing imputationSemanticsVersion changes the derived checksum', () => {
  const base = computeDerivedImputedSessionChecksum(basePayload());
  const changed = computeDerivedImputedSessionChecksum(basePayload({ imputationSemanticsVersion: 2 }));
  assert.notEqual(base, changed);
});

test('changing authorizationId changes the derived checksum', () => {
  const base = computeDerivedImputedSessionChecksum(basePayload());
  const changed = computeDerivedImputedSessionChecksum(basePayload({ authorizationId: 'SOME_OTHER_AUTHORIZATION' }));
  assert.notEqual(base, changed);
});

test('changing sourceSnapshotChecksum changes the derived checksum', () => {
  const base = computeDerivedImputedSessionChecksum(basePayload());
  const changed = computeDerivedImputedSessionChecksum(basePayload({ sourceSnapshotChecksum: 'd'.repeat(64) }));
  assert.notEqual(base, changed);
});

test('changing availableAt on one row changes the derived checksum (availability semantics are checksum-visible)', () => {
  const rows = basePayload().rows;
  const base = computeDerivedImputedSessionChecksum(basePayload());
  const mutatedRows: DerivedResearchSessionRowV1[] = rows.map((row, index) => (index === 1 ? { ...row, availableAt: '2022-03-07T05:00:00.000Z' } : row));
  const changed = computeDerivedImputedSessionChecksum(basePayload({ rows: mutatedRows }));
  assert.notEqual(base, changed);
});

test('changing a row provenance classification (OBSERVED vs IMPUTED) changes the derived checksum', () => {
  const base = computeDerivedImputedSessionChecksum(basePayload());
  const rows = basePayload().rows;
  const mutatedRows: DerivedResearchSessionRowV1[] = rows.map((row, index) =>
    index === 0 ? { ...row, provenance: { kind: ResearchRowProvenanceKind.OBSERVED, sourceSnapshotChecksum: 'z'.repeat(64) } } : row
  );
  const changed = computeDerivedImputedSessionChecksum(basePayload({ rows: mutatedRows }));
  assert.notEqual(base, changed);
});

test('a duplicated/misplaced row changes the checksum -- row order is NOT re-sorted away (unlike session-manifest content checksums)', () => {
  const payload = basePayload();
  const reordered = { ...payload, rows: [payload.rows[1], payload.rows[0], payload.rows[2]] };
  assert.notEqual(computeDerivedImputedSessionChecksum(payload), computeDerivedImputedSessionChecksum(reordered));
});

test('buildDerivedImputedResearchSession attaches a checksum consistent with computeDerivedImputedSessionChecksum', () => {
  const session = buildDerivedImputedResearchSession(basePayload());
  assert.equal(session.derivedContentChecksum, computeDerivedImputedSessionChecksum(basePayload()));
});

// ---- storage ----

test('storeDerivedImputedResearchSession + readDerivedImputedResearchSession round-trip', () => {
  const root = tempRoot();
  try {
    const session: DerivedImputedResearchSessionV1 = buildDerivedImputedResearchSession(basePayload());
    const stored = storeDerivedImputedResearchSession(root, session);
    assert.equal(stored.wasNewlyWritten, true);
    const readBack = readDerivedImputedResearchSession(root, session.derivedContentChecksum);
    assert.deepEqual(readBack, session);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('storing the identical derived session twice is an idempotent, verified skip', () => {
  const root = tempRoot();
  try {
    const session = buildDerivedImputedResearchSession(basePayload());
    const first = storeDerivedImputedResearchSession(root, session);
    const second = storeDerivedImputedResearchSession(root, session);
    assert.equal(first.wasNewlyWritten, true);
    assert.equal(second.wasNewlyWritten, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('precedenceTier is fixed at AUTHORIZED_DERIVED_IMPUTED_SESSION (tier 3) -- never claims tier 1/2', () => {
  const session = buildDerivedImputedResearchSession(basePayload());
  assert.equal(session.precedenceTier, ResearchSessionSourcePrecedenceTier.AUTHORIZED_DERIVED_IMPUTED_SESSION);
  assert.equal(ResearchSessionSourcePrecedenceTier.AUTHORIZED_DERIVED_IMPUTED_SESSION, 3);
  assert.ok(ResearchSessionSourcePrecedenceTier.HEALTHY_REAL_CANONICAL_SESSION < session.precedenceTier);
  assert.ok(ResearchSessionSourcePrecedenceTier.ACCEPTED_COMPOSITE_REPAIRED_CANONICAL_SESSION < session.precedenceTier);
});
