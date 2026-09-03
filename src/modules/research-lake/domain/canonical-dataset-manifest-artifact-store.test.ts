import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CanonicalDatasetManifestConflictError,
  canonicalDatasetManifestRelativePath,
  readCanonicalDatasetManifestArtifact,
  storeCanonicalDatasetManifestArtifact,
} from './canonical-dataset-manifest-artifact-store';
import {
  CANONICALIZATION_SEMANTICS_VERSION,
  DatasetManifest,
  HEALTH_SEMANTICS_VERSION,
  MANIFEST_SCHEMA_VERSION,
  ManifestDatasetKind,
  UnderlyingSessionIdentity,
  computeDatasetChecksum,
  deriveDatasetId,
} from './dataset-manifest.types';
import { DatasetHealthStatus } from './dataset-health.types';
import { HistoricalProviderId } from '../interfaces/historical-provider-capability.types';

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'canonical-manifest-store-test-'));
}

function identityFor(tradingDate: string): UnderlyingSessionIdentity {
  return { datasetKind: ManifestDatasetKind.UNDERLYING_1M, provider: HistoricalProviderId.UPSTOX, instrumentKey: 'NSE_INDEX|Nifty 50', timeframe: '1minute', tradingDate };
}

function fakeManifest(tradingDates: readonly string[]): DatasetManifest {
  const sessions = tradingDates.map((tradingDate) => ({
    identity: identityFor(tradingDate),
    canonicalizationVersion: CANONICALIZATION_SEMANTICS_VERSION,
    healthSemanticsVersion: HEALTH_SEMANTICS_VERSION,
    contentChecksum: `${'c'.repeat(63)}${tradingDate.slice(-1)}`,
    canonicalRowCount: 375,
    persistedCanonicalHealthStatus: DatasetHealthStatus.HEALTHY,
    optionObservationState: null,
    issues: [],
    rowsWithOi: null,
    rowsWithNullOi: null,
    sourceAcquisitionEvidence: { availability: 'UNAVAILABLE_FROM_PERSISTED_STORE' as never, providerRowCount: null, excludedRowCount: null, provenanceComposition: 'PRIMARY_ONLY' as never, compositeRepair: null, sourceOrderAnomalyCount: null, sourceHealthStatus: null, provider: null, evidenceSemanticChecksum: null },
    calendarSessionWindows: [{ windowIndex: 0, openMinuteIst: 555, closeMinuteIst: 930 }],
  }));
  const datasetChecksum = computeDatasetChecksum(sessions.map((s) => ({ identity: s.identity, canonicalizationVersion: s.canonicalizationVersion, healthSemanticsVersion: s.healthSemanticsVersion, contentChecksum: s.contentChecksum })));
  return {
    manifestSchemaVersion: MANIFEST_SCHEMA_VERSION,
    datasetKind: ManifestDatasetKind.UNDERLYING_1M,
    canonicalizationVersion: CANONICALIZATION_SEMANTICS_VERSION,
    healthSemanticsVersion: HEALTH_SEMANTICS_VERSION,
    datasetChecksum,
    datasetId: deriveDatasetId(ManifestDatasetKind.UNDERLYING_1M, datasetChecksum),
    provenance: { provider: HistoricalProviderId.UPSTOX, datasetKind: ManifestDatasetKind.UNDERLYING_1M, instrumentDescriptor: 'NSE_INDEX|Nifty 50', requestedFromDate: tradingDates[0], requestedToDate: tradingDates[tradingDates.length - 1], acquisitionPath: 'PERSISTED_STORE_RECONSTRUCTION', gitRevision: null },
    generatedAt: '2026-01-01T00:00:00.000Z',
    sessions,
    sessionCounts: { requested: tradingDates.length, included: tradingDates.length, healthy: tradingDates.length, incomplete: 0, invalid: 0, byPersistedCanonicalHealthStatus: {} as never },
  };
}

test('first store is a new write; second identical store is a verified idempotent reuse', () => {
  const root = tempRoot();
  try {
    const manifest = fakeManifest(['2022-01-03', '2022-01-04']);
    const first = storeCanonicalDatasetManifestArtifact(root, manifest);
    assert.equal(first.wasNewlyWritten, true);
    assert.equal(first.relativePath, canonicalDatasetManifestRelativePath(manifest));
    const second = storeCanonicalDatasetManifestArtifact(root, manifest);
    assert.equal(second.wasNewlyWritten, false);
    assert.equal(second.relativePath, first.relativePath);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a differing existing artifact at the same path fails closed -- never overwritten', () => {
  const root = tempRoot();
  try {
    const manifestA = fakeManifest(['2022-01-03']);
    const stored = storeCanonicalDatasetManifestArtifact(root, manifestA);
    // Tamper the on-disk artifact directly (simulating a conflicting prior write).
    const tampered = { ...manifestA, datasetChecksum: 'f'.repeat(64) };
    writeFileSync(stored.absolutePath, JSON.stringify(tampered, null, 2));

    assert.throws(() => storeCanonicalDatasetManifestArtifact(root, manifestA), CanonicalDatasetManifestConflictError);
    // The on-disk bytes must remain the tampered ones -- never silently overwritten.
    const onDisk = JSON.parse(readFileSync(stored.absolutePath, 'utf8'));
    assert.equal(onDisk.datasetChecksum, 'f'.repeat(64));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an internally inconsistent candidate (self-declared datasetChecksum does not match its own sessions) is rejected before any write', () => {
  const root = tempRoot();
  try {
    const manifest = fakeManifest(['2022-01-03']);
    const inconsistent = { ...manifest, datasetChecksum: 'e'.repeat(64) };
    assert.throws(() => storeCanonicalDatasetManifestArtifact(root, inconsistent));
    assert.equal(readCanonicalDatasetManifestArtifactSafely(root, manifest), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function readCanonicalDatasetManifestArtifactSafely(root: string, manifest: DatasetManifest): DatasetManifest | null {
  try {
    return readCanonicalDatasetManifestArtifact(root, manifest.datasetKind, manifest.datasetId);
  } catch {
    return null;
  }
}

test('readCanonicalDatasetManifestArtifact reads back exactly what was stored', () => {
  const root = tempRoot();
  try {
    const manifest = fakeManifest(['2022-01-03', '2022-01-04']);
    storeCanonicalDatasetManifestArtifact(root, manifest);
    const readBack = readCanonicalDatasetManifestArtifact(root, manifest.datasetKind, manifest.datasetId);
    assert.equal(readBack.datasetChecksum, manifest.datasetChecksum);
    assert.equal(readBack.sessions.length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('reading a missing artifact throws', () => {
  const root = tempRoot();
  try {
    assert.throws(() => readCanonicalDatasetManifestArtifact(root, ManifestDatasetKind.UNDERLYING_1M, 'UNDERLYING_1M_doesnotexist'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
