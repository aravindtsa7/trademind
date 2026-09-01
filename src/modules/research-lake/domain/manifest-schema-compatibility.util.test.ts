import assert from 'node:assert/strict';
import test from 'node:test';
import { HistoricalProviderId } from '../interfaces/historical-provider-capability.types';
import { DatasetHealthStatus } from './dataset-health.types';
import {
  DatasetManifest,
  MANIFEST_SCHEMA_VERSION,
  ManifestDatasetKind,
  SessionManifest,
  SourceAcquisitionEvidenceAvailability,
  SourceAcquisitionProvenanceComposition,
} from './dataset-manifest.types';
import { ManifestSchemaCompatibilityError, MIN_SUPPORTED_MANIFEST_SCHEMA_VERSION, assertManifestSchemaCompatible } from './manifest-schema-compatibility.util';

const INSTRUMENT_KEY = 'NSE_INDEX|Nifty 50';

function sessionWithProvenance(provenanceComposition: SourceAcquisitionProvenanceComposition): SessionManifest {
  return {
    identity: { datasetKind: ManifestDatasetKind.UNDERLYING_1M, provider: HistoricalProviderId.UPSTOX, instrumentKey: INSTRUMENT_KEY, timeframe: '1minute', tradingDate: '2022-01-03' },
    canonicalizationVersion: 1,
    healthSemanticsVersion: 1,
    contentChecksum: 'a'.repeat(64),
    canonicalRowCount: 375,
    persistedCanonicalHealthStatus: DatasetHealthStatus.HEALTHY,
    optionObservationState: null,
    issues: [],
    rowsWithOi: null,
    rowsWithNullOi: null,
    sourceAcquisitionEvidence: {
      availability: SourceAcquisitionEvidenceAvailability.UNAVAILABLE_FROM_PERSISTED_STORE,
      providerRowCount: null,
      excludedRowCount: null,
      sourceOrderAnomalyCount: null,
      sourceHealthStatus: null,
      provider: null,
      evidenceSemanticChecksum: null,
      provenanceComposition,
      compositeRepair: null,
    },
    calendarSessionWindows: [],
  };
}

function manifestFixture(overrides: Partial<DatasetManifest> = {}, sessions: readonly SessionManifest[] = [sessionWithProvenance(SourceAcquisitionProvenanceComposition.PRIMARY_ONLY)]): DatasetManifest {
  return {
    manifestSchemaVersion: MANIFEST_SCHEMA_VERSION,
    datasetKind: ManifestDatasetKind.UNDERLYING_1M,
    canonicalizationVersion: 1,
    healthSemanticsVersion: 1,
    datasetChecksum: 'a'.repeat(64),
    datasetId: 'UNDERLYING_1M_aaaaaaaaaaaaaaaa',
    provenance: {
      provider: HistoricalProviderId.UPSTOX,
      datasetKind: ManifestDatasetKind.UNDERLYING_1M,
      instrumentDescriptor: INSTRUMENT_KEY,
      requestedFromDate: '2022-01-03',
      requestedToDate: '2022-01-03',
      acquisitionPath: 'PERSISTED_STORE_RECONSTRUCTION',
      gitRevision: null,
    },
    generatedAt: new Date().toISOString(),
    sessions,
    sessionCounts: { requested: sessions.length, included: sessions.length, healthy: sessions.length, incomplete: 0, invalid: 0, byPersistedCanonicalHealthStatus: {} as never },
    ...overrides,
  };
}

function assertRejects(manifest: DatasetManifest, expectedCode: string): void {
  assert.throws(
    () => assertManifestSchemaCompatible(manifest),
    (error: unknown) => error instanceof ManifestSchemaCompatibilityError && error.code === expectedCode
  );
}

// ============================================================================
// B-F2D: old-reader / new-artifact compatibility proof (Terra's required list)
// ============================================================================

test('(1) v4 artifact + PRIMARY_ONLY -> accepted by current v5 reader', () => {
  const manifest = manifestFixture({ manifestSchemaVersion: 4 }, [sessionWithProvenance(SourceAcquisitionProvenanceComposition.PRIMARY_ONLY)]);
  assert.doesNotThrow(() => assertManifestSchemaCompatible(manifest));
});

test('(2) v4 artifact + COMPOSITE_REPAIRED -> accepted by current v5 reader', () => {
  const manifest = manifestFixture({ manifestSchemaVersion: 4 }, [sessionWithProvenance(SourceAcquisitionProvenanceComposition.COMPOSITE_REPAIRED)]);
  assert.doesNotThrow(() => assertManifestSchemaCompatible(manifest));
});

test('(3) v4 artifact + UNKNOWN_LEGACY_REPAIR_PROVENANCE -> rejected as invalid v4 contract', () => {
  const manifest = manifestFixture({ manifestSchemaVersion: 4 }, [sessionWithProvenance(SourceAcquisitionProvenanceComposition.UNKNOWN_LEGACY_REPAIR_PROVENANCE)]);
  assertRejects(manifest, 'INVALID_PROVENANCE_COMPOSITION');
});

test('(4) v5 artifact + UNKNOWN_LEGACY_REPAIR_PROVENANCE -> accepted', () => {
  const manifest = manifestFixture({ manifestSchemaVersion: 5 }, [sessionWithProvenance(SourceAcquisitionProvenanceComposition.UNKNOWN_LEGACY_REPAIR_PROVENANCE)]);
  assert.doesNotThrow(() => assertManifestSchemaCompatible(manifest));
});

test('(5) v5 artifact + PRIMARY_ONLY -> accepted', () => {
  const manifest = manifestFixture({ manifestSchemaVersion: 5 }, [sessionWithProvenance(SourceAcquisitionProvenanceComposition.PRIMARY_ONLY)]);
  assert.doesNotThrow(() => assertManifestSchemaCompatible(manifest));
});

test('(6) v5 artifact + COMPOSITE_REPAIRED -> accepted', () => {
  const manifest = manifestFixture({ manifestSchemaVersion: 5 }, [sessionWithProvenance(SourceAcquisitionProvenanceComposition.COMPOSITE_REPAIRED)]);
  assert.doesNotThrow(() => assertManifestSchemaCompatible(manifest));
});

test('(7) v6/future manifest -> rejected before semantic use', () => {
  const manifest = manifestFixture({ manifestSchemaVersion: 6 });
  assertRejects(manifest, 'FUTURE_SCHEMA_VERSION');
});

test('(8) malformed / missing manifestSchemaVersion -> fail closed according to explicit policy', () => {
  const missing = manifestFixture({ manifestSchemaVersion: undefined as unknown as number });
  assertRejects(missing, 'MISSING_OR_INVALID_SCHEMA_VERSION');

  const nonInteger = manifestFixture({ manifestSchemaVersion: 4.5 });
  assertRejects(nonInteger, 'MISSING_OR_INVALID_SCHEMA_VERSION');

  const wrongType = manifestFixture({ manifestSchemaVersion: '5' as unknown as number });
  assertRejects(wrongType, 'MISSING_OR_INVALID_SCHEMA_VERSION');
});

test('(9) unknown provenance enum string -> rejected at runtime, never relying on TypeScript typing after JSON.parse', () => {
  const manifest = manifestFixture({ manifestSchemaVersion: 5 }, [sessionWithProvenance('SOME_FUTURE_VALUE_NOT_YET_INVENTED' as unknown as SourceAcquisitionProvenanceComposition)]);
  assertRejects(manifest, 'INVALID_PROVENANCE_COMPOSITION');
});

// ---- supplementary: supported-history boundary + defense-in-depth ----------

test('B-F2D CORRECTION: MIN_SUPPORTED_MANIFEST_SCHEMA_VERSION is 1, not an arbitrary 4 -- restores the full documented v1-v5 history (see this file\'s own compatibility matrix doc)', () => {
  assert.equal(MIN_SUPPORTED_MANIFEST_SCHEMA_VERSION, 1);
});

test('a negative/zero schema version is rejected fail-closed as unsupported ancient, never treated as valid', () => {
  assertRejects(manifestFixture({ manifestSchemaVersion: 0 }), 'UNSUPPORTED_ANCIENT_SCHEMA_VERSION');
  assertRejects(manifestFixture({ manifestSchemaVersion: -1 }), 'UNSUPPORTED_ANCIENT_SCHEMA_VERSION');
});

test('a completely malformed manifest object (null/non-object) is rejected fail-closed rather than throwing an unrelated TypeError', () => {
  assert.throws(() => assertManifestSchemaCompatible(null as unknown as DatasetManifest), ManifestSchemaCompatibilityError);
  assert.throws(() => assertManifestSchemaCompatible(undefined as unknown as DatasetManifest), ManifestSchemaCompatibilityError);
});

test('multiple sessions: one invalid provenanceComposition anywhere in the array is sufficient to reject the whole manifest', () => {
  const manifest = manifestFixture({ manifestSchemaVersion: 4 }, [
    sessionWithProvenance(SourceAcquisitionProvenanceComposition.PRIMARY_ONLY),
    sessionWithProvenance(SourceAcquisitionProvenanceComposition.UNKNOWN_LEGACY_REPAIR_PROVENANCE),
  ]);
  assertRejects(manifest, 'INVALID_PROVENANCE_COMPOSITION');
});

// ============================================================================
// B-F2D CORRECTION (Terra re-review HIGH-2/MEDIUM): `sessions` structural
// validation -- missing/null/non-array is always rejected; a present-but-
// EMPTY array is separately rejected because current DatasetManifest
// generation can never legitimately produce zero sessions (see
// `DatasetManifestService.assertBoundedSortedDates`, which requires a
// non-empty `tradingDates` request and pushes exactly one session per
// requested date -- confirmed by `research-year-runner.service.ts`, which
// explicitly short-circuits BEFORE ever calling `generateManifest()` when
// there are zero healthy trading dates, returning `datasetId: null` rather
// than a zero-session `DatasetManifest`).
// ============================================================================

test('missing sessions field is rejected fail-closed, never silently treated as zero sessions', () => {
  const manifest = { ...manifestFixture({ manifestSchemaVersion: 5 }) } as Record<string, unknown>;
  delete manifest.sessions;
  assertRejects(manifest as unknown as DatasetManifest, 'MISSING_OR_INVALID_SESSIONS');
});

test('sessions === null is rejected fail-closed', () => {
  const manifest = manifestFixture({ manifestSchemaVersion: 5, sessions: null as unknown as DatasetManifest['sessions'] });
  assertRejects(manifest, 'MISSING_OR_INVALID_SESSIONS');
});

test('non-array sessions (a plain object, or a string) is rejected fail-closed', () => {
  assertRejects(manifestFixture({ manifestSchemaVersion: 5, sessions: {} as unknown as DatasetManifest['sessions'] }), 'MISSING_OR_INVALID_SESSIONS');
  assertRejects(manifestFixture({ manifestSchemaVersion: 5, sessions: 'sessions' as unknown as DatasetManifest['sessions'] }), 'MISSING_OR_INVALID_SESSIONS');
});

test('an explicitly present but EMPTY sessions array is rejected -- current generation can never legitimately produce it, so it is never conflated with "missing sessions" nor silently accepted as an empty dataset', () => {
  assertRejects(manifestFixture({ manifestSchemaVersion: 4 }, []), 'EMPTY_SESSIONS');
  assertRejects(manifestFixture({ manifestSchemaVersion: 5 }, []), 'EMPTY_SESSIONS');
  assertRejects(manifestFixture({ manifestSchemaVersion: 1 }, []), 'EMPTY_SESSIONS');
});

// ============================================================================
// B-F2D CORRECTION (Terra re-review HIGH-2): recovered v1/v2/v3 wire history
// -- fixtures below match the EXACT committed shape at each version (see
// `manifest-schema-compatibility.util.ts`'s own compatibility matrix doc),
// not the current v5 shape with fields merely omitted. Cast through
// `unknown` because TypeScript's CURRENT `SessionManifest`/
// `SourceAcquisitionEvidence` types require fields that genuinely did not
// exist at these versions -- this simulates a real `JSON.parse`'d historical
// artifact, which has exactly these runtime keys regardless of what the
// current compile-time type declares.
// ============================================================================

/** v1 (commit 8dd72c8): `sourceAcquisitionEvidence` has ONLY {availability, providerRowCount, excludedRowCount, sourceOrderAnomalyCount, sourceHealthStatus} -- no `provider`, no `evidenceSemanticChecksum`, no `provenanceComposition`, no `compositeRepair`. `SessionManifest` has NO `calendarSessionWindows` key at all. */
function v1SessionRaw(): unknown {
  return {
    identity: { datasetKind: ManifestDatasetKind.UNDERLYING_1M, provider: HistoricalProviderId.UPSTOX, instrumentKey: INSTRUMENT_KEY, timeframe: '1minute', tradingDate: '2022-01-03' },
    canonicalizationVersion: 1,
    healthSemanticsVersion: 1,
    contentChecksum: 'a'.repeat(64),
    canonicalRowCount: 375,
    persistedCanonicalHealthStatus: DatasetHealthStatus.HEALTHY,
    optionObservationState: null,
    issues: [],
    rowsWithOi: null,
    rowsWithNullOi: null,
    sourceAcquisitionEvidence: {
      availability: SourceAcquisitionEvidenceAvailability.UNAVAILABLE_FROM_PERSISTED_STORE,
      providerRowCount: null,
      excludedRowCount: null,
      sourceOrderAnomalyCount: null,
      sourceHealthStatus: null,
    },
  };
}

/** v2 (commit 077f6fa, B-F2C): `sourceAcquisitionEvidence` gains `provider`/`evidenceSemanticChecksum`. Still NO `calendarSessionWindows`, still NO `provenanceComposition`/`compositeRepair`. */
function v2SessionRaw(): unknown {
  const base = v1SessionRaw() as Record<string, unknown>;
  return {
    ...base,
    sourceAcquisitionEvidence: { ...(base.sourceAcquisitionEvidence as Record<string, unknown>), provider: null, evidenceSemanticChecksum: null },
  };
}

/** v3 (commit 584d46b = current HEAD, B-F5 CALENDAR FIX): `SessionManifest` gains `calendarSessionWindows`. `sourceAcquisitionEvidence` unchanged from v2 -- still no `provenanceComposition`/`compositeRepair`. */
function v3SessionRaw(): unknown {
  return { ...(v2SessionRaw() as Record<string, unknown>), calendarSessionWindows: [] };
}

function historicalManifestFixture(version: number, sessions: readonly unknown[]): DatasetManifest {
  return {
    manifestSchemaVersion: version,
    datasetKind: ManifestDatasetKind.UNDERLYING_1M,
    canonicalizationVersion: 1,
    healthSemanticsVersion: 1,
    datasetChecksum: 'a'.repeat(64),
    datasetId: 'UNDERLYING_1M_aaaaaaaaaaaaaaaa',
    provenance: {
      provider: HistoricalProviderId.UPSTOX,
      datasetKind: ManifestDatasetKind.UNDERLYING_1M,
      instrumentDescriptor: INSTRUMENT_KEY,
      requestedFromDate: '2022-01-03',
      requestedToDate: '2022-01-03',
      acquisitionPath: 'PERSISTED_STORE_RECONSTRUCTION',
      gitRevision: null,
    },
    generatedAt: new Date().toISOString(),
    sessions,
    sessionCounts: { requested: sessions.length, included: sessions.length, healthy: sessions.length, incomplete: 0, invalid: 0, byPersistedCanonicalHealthStatus: {} as never },
  } as unknown as DatasetManifest;
}

test('(v1 COMPATIBILITY) a genuine v1-shaped manifest -- no provider/evidenceSemanticChecksum/provenanceComposition/compositeRepair, no calendarSessionWindows anywhere -- is accepted', () => {
  assert.doesNotThrow(() => assertManifestSchemaCompatible(historicalManifestFixture(1, [v1SessionRaw()])));
});

test('(v2 COMPATIBILITY) a genuine v2-shaped manifest -- provider/evidenceSemanticChecksum present, still no provenanceComposition/calendarSessionWindows -- is accepted', () => {
  assert.doesNotThrow(() => assertManifestSchemaCompatible(historicalManifestFixture(2, [v2SessionRaw()])));
});

test('(v3 COMPATIBILITY) a genuine v3-shaped manifest -- calendarSessionWindows present, still no provenanceComposition -- is accepted', () => {
  assert.doesNotThrow(() => assertManifestSchemaCompatible(historicalManifestFixture(3, [v3SessionRaw()])));
});

test('(v1-v3) provenanceComposition is never required/validated below PROVENANCE_COMPOSITION_INTRODUCED_AT_SCHEMA_VERSION -- an artifact missing the field entirely is not fabricated into PRIMARY_ONLY or UNKNOWN, it simply is not checked', () => {
  for (const version of [1, 2, 3]) {
    const session = version === 1 ? v1SessionRaw() : version === 2 ? v2SessionRaw() : v3SessionRaw();
    assert.ok(!('provenanceComposition' in ((session as Record<string, unknown>).sourceAcquisitionEvidence as object)), `v${version} fixture must genuinely omit provenanceComposition to prove this`);
    assert.doesNotThrow(() => assertManifestSchemaCompatible(historicalManifestFixture(version, [session])));
  }
});

test('never silently coerces a v5 manifest to v4, or an unknown provenance value to PRIMARY_ONLY -- rejection always throws, the manifest is never mutated', () => {
  const original = manifestFixture({ manifestSchemaVersion: 6 });
  const snapshot = JSON.parse(JSON.stringify(original));
  assert.throws(() => assertManifestSchemaCompatible(original));
  assert.deepEqual(original, snapshot, 'assertManifestSchemaCompatible must never mutate its input, even when rejecting it');
});
