import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ResearchSessionSourcePrecedenceTier } from './derived-imputed-research-session.types';
import { ResampleTargetTimeframe } from './resampled-candle.types';
import { ManifestDatasetKind } from './dataset-manifest.types';
import { ParquetCompressionCodec, ParquetWriterFormat } from './parquet-storage.types';
import {
  BuildResearchUnderlyingYearCertificationInput,
  CertificationPhysicalStorageReference,
  CertifiedSessionRecord,
  March7NoLookaheadProof,
  March7NoLookaheadProofEntry,
  RESEARCH_UNDERLYING_YEAR_CERTIFICATION_SCHEMA_VERSION,
  RESEARCH_UNDERLYING_YEAR_CERTIFICATION_STORAGE_ROOT,
  ResearchUnderlyingYearCertificationIntegrityError,
  ResearchUnderlyingYearCertificationV1,
  buildResearchUnderlyingYearCertification,
  computeResearchUnderlyingYearCertificationChecksum,
  deriveResearchUnderlyingYearCertificationSummary,
  readResearchUnderlyingYearCertification,
  researchUnderlyingYearCertificationRelativePath,
  storeResearchUnderlyingYearCertification,
} from './research-underlying-year-certification.types';

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'year-certification-test-'));
}

const REGULAR_WINDOW = { windowIndex: 0, openMinuteIst: 555, closeMinuteIst: 930 };
const MARCH7_PROOF: March7NoLookaheadProof = {
  tradingDate: '2022-03-07',
  imputedMinutesIst: ['10:22', '10:23', '10:24'],
  leftRealAnchorIst: '10:21',
  rightRealAnchorIst: '10:25',
  entries: [
    { target: ResampleTargetTimeframe.TWO_MINUTE, bucketStartIst: '10:21', expectedAvailableAtIst: '10:26', verified: true },
    { target: ResampleTargetTimeframe.TWO_MINUTE, bucketStartIst: '10:23', expectedAvailableAtIst: '10:26', verified: true },
    { target: ResampleTargetTimeframe.THREE_MINUTE, bucketStartIst: '10:21', expectedAvailableAtIst: '10:26', verified: true },
    { target: ResampleTargetTimeframe.THREE_MINUTE, bucketStartIst: '10:24', expectedAvailableAtIst: '10:27', verified: true },
    { target: ResampleTargetTimeframe.FIVE_MINUTE, bucketStartIst: '10:20', expectedAvailableAtIst: '10:26', verified: true },
  ],
};

function physicalStorageRef(overrides: Partial<CertificationPhysicalStorageReference> = {}): CertificationPhysicalStorageReference {
  return {
    storageSchemaVersion: 1,
    datasetId: 'UNDERLYING_1M_abc',
    datasetChecksum: '1'.repeat(64),
    datasetKind: ManifestDatasetKind.UNDERLYING_1M,
    writerFormat: ParquetWriterFormat.PARQUET,
    writerLibrary: 'hyparquet-writer',
    writerLibraryVersion: '0.16.6',
    compressionCodec: ParquetCompressionCodec.SNAPPY,
    sessions: [{ tradingDate: '2022-01-03', sessionContentChecksum: 'c'.repeat(64), canonicalRowCount: 375, physicalFileChecksum: 'p'.repeat(64) }],
    ...overrides,
  };
}

function targetRecord(target: ResampleTargetTimeframe, overrides: Partial<Record<string, unknown>> = {}) {
  return { target, researchDerivedContentChecksum: 'r'.repeat(64), outputCandleCount: 187, structuralTrailingRowCount: 0, candlesContainingImputation: 0, noLookaheadVerified: true, ...overrides };
}

function sessionRecord(tradingDate: string, tier: ResearchSessionSourcePrecedenceTier = ResearchSessionSourcePrecedenceTier.HEALTHY_REAL_CANONICAL_SESSION): CertifiedSessionRecord {
  return {
    tradingDate,
    calendarSessionWindows: [REGULAR_WINDOW],
    sourcePrecedenceTier: tier,
    sourceContentChecksum: 'c'.repeat(64),
    sourceRowCount: 375,
    realCanonicalRowCount: tier === ResearchSessionSourcePrecedenceTier.HEALTHY_REAL_CANONICAL_SESSION ? 375 : 0,
    derivedObservedRowCount: 0,
    derivedImputedRowCount: 0,
    oneMinuteVerificationChecksum: 'v'.repeat(64),
    targets: [
      targetRecord(ResampleTargetTimeframe.TWO_MINUTE),
      targetRecord(ResampleTargetTimeframe.THREE_MINUTE, { outputCandleCount: 125 }),
      targetRecord(ResampleTargetTimeframe.FIVE_MINUTE, { outputCandleCount: 75 }),
    ],
  };
}

function baseInput(overrides: Partial<BuildResearchUnderlyingYearCertificationInput> = {}): BuildResearchUnderlyingYearCertificationInput {
  const sessions = overrides.sessions ?? [sessionRecord('2022-01-03'), sessionRecord('2022-01-04'), sessionRecord('2022-03-07', ResearchSessionSourcePrecedenceTier.AUTHORIZED_DERIVED_IMPUTED_SESSION)];
  return {
    schemaVersion: RESEARCH_UNDERLYING_YEAR_CERTIFICATION_SCHEMA_VERSION,
    certificationSemanticsVersion: 1,
    identity: { instrumentKey: 'NSE_INDEX|Nifty 50', sourceTimeframe: '1minute', year: 2022 },
    calendar: { expectedSessionCount: 3 },
    canonicalManifest: { datasetId: 'UNDERLYING_1M_abc', datasetChecksum: '1'.repeat(64), manifestSchemaVersion: 5, canonicalizationVersion: 1, healthSemanticsVersion: 1 },
    physicalStorage: physicalStorageRef(),
    derivedSnapshotChecksum: 'a'.repeat(64),
    derivedSessionChecksum: 'b'.repeat(64),
    sourceAssemblyChecksum: '8'.repeat(64),
    resamplingManifestChecksum: '3'.repeat(64),
    sessions,
    march7Proof: MARCH7_PROOF,
    ...overrides,
  };
}

/** B-M9: a clean-canonical-year (e.g. 2023) fixture -- ZERO authorized-derived sessions, all three derived-specific fields explicitly null. */
function cleanYearBaseInput(overrides: Partial<BuildResearchUnderlyingYearCertificationInput> = {}): BuildResearchUnderlyingYearCertificationInput {
  const sessions = overrides.sessions ?? [sessionRecord('2023-01-02'), sessionRecord('2023-01-03')];
  return {
    schemaVersion: RESEARCH_UNDERLYING_YEAR_CERTIFICATION_SCHEMA_VERSION,
    certificationSemanticsVersion: 1,
    identity: { instrumentKey: 'NSE_INDEX|Nifty 50', sourceTimeframe: '1minute', year: 2023 },
    calendar: { expectedSessionCount: 2 },
    canonicalManifest: { datasetId: 'UNDERLYING_1M_xyz', datasetChecksum: '2'.repeat(64), manifestSchemaVersion: 5, canonicalizationVersion: 1, healthSemanticsVersion: 1 },
    physicalStorage: physicalStorageRef({ sessions: [{ tradingDate: '2023-01-02', sessionContentChecksum: 'c'.repeat(64), canonicalRowCount: 375, physicalFileChecksum: 'p'.repeat(64) }] }),
    derivedSnapshotChecksum: null,
    derivedSessionChecksum: null,
    sourceAssemblyChecksum: '7'.repeat(64),
    resamplingManifestChecksum: '4'.repeat(64),
    sessions,
    march7Proof: null,
    ...overrides,
  };
}

// ---- determinism / ordering ----

test('same input -> identical certificationContentChecksum', () => {
  const a = buildResearchUnderlyingYearCertification(baseInput());
  const b = buildResearchUnderlyingYearCertification(baseInput());
  assert.equal(a.certificationContentChecksum, b.certificationContentChecksum);
});

test('session input ordering does not change the checksum', () => {
  const input = baseInput();
  const a = buildResearchUnderlyingYearCertification(input);
  const b = buildResearchUnderlyingYearCertification({ ...input, sessions: [...input.sessions].reverse() });
  assert.equal(a.certificationContentChecksum, b.certificationContentChecksum);
});

test('sessions are always stored sorted ascending by tradingDate', () => {
  const input = baseInput({ sessions: [sessionRecord('2022-03-07', ResearchSessionSourcePrecedenceTier.AUTHORIZED_DERIVED_IMPUTED_SESSION), sessionRecord('2022-01-03'), sessionRecord('2022-01-04')] });
  const certification = buildResearchUnderlyingYearCertification(input);
  assert.deepEqual(certification.sessions.map((s) => s.tradingDate), ['2022-01-03', '2022-01-04', '2022-03-07']);
});

// ---- duplicate / target-set validation ----

test('duplicate session date fails closed', () => {
  assert.throws(() => buildResearchUnderlyingYearCertification(baseInput({ sessions: [sessionRecord('2022-01-03'), sessionRecord('2022-01-03')] })), /duplicate trading-date/);
});

test('a missing target on one session fails closed', () => {
  const bad = { ...sessionRecord('2022-01-03'), targets: [targetRecord(ResampleTargetTimeframe.TWO_MINUTE), targetRecord(ResampleTargetTimeframe.THREE_MINUTE)] };
  assert.throws(() => buildResearchUnderlyingYearCertification(baseInput({ sessions: [bad] })), /expected exactly 3/);
});

test('an extra/duplicate target on one session fails closed', () => {
  const bad = { ...sessionRecord('2022-01-03'), targets: [targetRecord(ResampleTargetTimeframe.TWO_MINUTE), targetRecord(ResampleTargetTimeframe.TWO_MINUTE), targetRecord(ResampleTargetTimeframe.THREE_MINUTE), targetRecord(ResampleTargetTimeframe.FIVE_MINUTE)] };
  assert.throws(() => buildResearchUnderlyingYearCertification(baseInput({ sessions: [bad] })));
});

test('duplicate physical storage entries fail closed', () => {
  const input = baseInput({
    physicalStorage: physicalStorageRef({
      sessions: [
        { tradingDate: '2022-01-03', sessionContentChecksum: 'c'.repeat(64), canonicalRowCount: 375, physicalFileChecksum: 'p'.repeat(64) },
        { tradingDate: '2022-01-03', sessionContentChecksum: 'c'.repeat(64), canonicalRowCount: 375, physicalFileChecksum: 'p'.repeat(64) },
      ],
    }),
  });
  assert.throws(() => buildResearchUnderlyingYearCertification(input));
});

// ---- summary coherence ----

test('summary is coherent: verifiedSessions/realCanonicalSessions/authorizedDerivedSessions/byTarget derived from sessions', () => {
  const certification = buildResearchUnderlyingYearCertification(baseInput());
  assert.equal(certification.summary.expectedSessions, 3);
  assert.equal(certification.summary.verifiedSessions, 3);
  assert.equal(certification.summary.realCanonicalSessions, 2);
  assert.equal(certification.summary.authorizedDerivedSessions, 1);
  assert.equal(certification.summary.total1mRows, 3 * 375);
  assert.equal(certification.summary.byTarget[ResampleTargetTimeframe.TWO_MINUTE].totalOutputCandles, 187 * 3);
  assert.equal(certification.summary.byTarget[ResampleTargetTimeframe.THREE_MINUTE].totalOutputCandles, 125 * 3);
  assert.equal(certification.summary.byTarget[ResampleTargetTimeframe.FIVE_MINUTE].totalOutputCandles, 75 * 3);
});

// ---- checksum sensitivity ----

test('changing a session target field (researchDerivedContentChecksum) changes the certification checksum', () => {
  const base = buildResearchUnderlyingYearCertification(baseInput());
  const mutated = baseInput().sessions.map((s, i) => (i === 0 ? { ...s, targets: s.targets.map((t) => (t.target === ResampleTargetTimeframe.TWO_MINUTE ? { ...t, researchDerivedContentChecksum: 'z'.repeat(64) } : t)) } : s));
  const changed = buildResearchUnderlyingYearCertification(baseInput({ sessions: mutated }));
  assert.notEqual(base.certificationContentChecksum, changed.certificationContentChecksum);
});

test('changing physical Parquet checksum changes the certification checksum', () => {
  const base = buildResearchUnderlyingYearCertification(baseInput());
  const changed = buildResearchUnderlyingYearCertification(
    baseInput({ physicalStorage: physicalStorageRef({ sessions: [{ tradingDate: '2022-01-03', sessionContentChecksum: 'c'.repeat(64), canonicalRowCount: 375, physicalFileChecksum: 'X'.repeat(64) }] }) })
  );
  assert.notEqual(base.certificationContentChecksum, changed.certificationContentChecksum);
});

// ---- B-M8-HIGH-01: physical-storage identity is fully bound (datasetId/datasetKind/writerFormat/writerLibrary/writerLibraryVersion/compressionCodec) ----

test('B-M8-HIGH-01: altering only physicalStorage.datasetId changes the certification checksum', () => {
  const base = buildResearchUnderlyingYearCertification(baseInput());
  const changed = buildResearchUnderlyingYearCertification(baseInput({ physicalStorage: physicalStorageRef({ datasetId: 'FORGED_DATASET_ID' }) }));
  assert.notEqual(base.certificationContentChecksum, changed.certificationContentChecksum);
});

test('B-M8-HIGH-01: altering only physicalStorage.datasetKind changes the certification checksum', () => {
  const base = buildResearchUnderlyingYearCertification(baseInput());
  const changed = buildResearchUnderlyingYearCertification(baseInput({ physicalStorage: physicalStorageRef({ datasetKind: ManifestDatasetKind.EXPIRED_OPTION_1M }) }));
  assert.notEqual(base.certificationContentChecksum, changed.certificationContentChecksum);
});

test('B-M8-HIGH-01: altering only physicalStorage.writerFormat changes the certification checksum', () => {
  const base = buildResearchUnderlyingYearCertification(baseInput());
  const changed = buildResearchUnderlyingYearCertification(baseInput({ physicalStorage: physicalStorageRef({ writerFormat: 'FORGED_FORMAT' as unknown as ParquetWriterFormat }) }));
  assert.notEqual(base.certificationContentChecksum, changed.certificationContentChecksum);
});

test('B-M8-HIGH-01: altering only physicalStorage.writerLibrary changes the certification checksum', () => {
  const base = buildResearchUnderlyingYearCertification(baseInput());
  const changed = buildResearchUnderlyingYearCertification(baseInput({ physicalStorage: physicalStorageRef({ writerLibrary: 'forged-writer-lib' }) }));
  assert.notEqual(base.certificationContentChecksum, changed.certificationContentChecksum);
});

test('B-M8-HIGH-01: altering only physicalStorage.writerLibraryVersion changes the certification checksum', () => {
  const base = buildResearchUnderlyingYearCertification(baseInput());
  const changed = buildResearchUnderlyingYearCertification(baseInput({ physicalStorage: physicalStorageRef({ writerLibraryVersion: '999.999.999' }) }));
  assert.notEqual(base.certificationContentChecksum, changed.certificationContentChecksum);
});

test('B-M8-HIGH-01: altering only physicalStorage.compressionCodec changes the certification checksum', () => {
  const base = buildResearchUnderlyingYearCertification(baseInput());
  const changed = buildResearchUnderlyingYearCertification(baseInput({ physicalStorage: physicalStorageRef({ compressionCodec: 'GZIP' as unknown as ParquetCompressionCodec }) }));
  assert.notEqual(base.certificationContentChecksum, changed.certificationContentChecksum);
});

test('B-M8-HIGH-01: physicalStorage has no generatedAt-equivalent field at all -- an identical rebuild is byte-identical', () => {
  const a = buildResearchUnderlyingYearCertification(baseInput());
  const b = buildResearchUnderlyingYearCertification(baseInput());
  assert.equal(JSON.stringify(a.physicalStorage), JSON.stringify(b.physicalStorage));
  assert.equal(/generatedAt/i.test(JSON.stringify(a)), false);
});

test('changing B-M7.2/B-M7.3/derived checksums each change the certification checksum', () => {
  const base = buildResearchUnderlyingYearCertification(baseInput());
  assert.notEqual(base.certificationContentChecksum, buildResearchUnderlyingYearCertification(baseInput({ sourceAssemblyChecksum: '9'.repeat(64) })).certificationContentChecksum);
  assert.notEqual(base.certificationContentChecksum, buildResearchUnderlyingYearCertification(baseInput({ resamplingManifestChecksum: '9'.repeat(64) })).certificationContentChecksum);
  assert.notEqual(base.certificationContentChecksum, buildResearchUnderlyingYearCertification(baseInput({ derivedSnapshotChecksum: '9'.repeat(64) })).certificationContentChecksum);
  assert.notEqual(base.certificationContentChecksum, buildResearchUnderlyingYearCertification(baseInput({ derivedSessionChecksum: '9'.repeat(64) })).certificationContentChecksum);
});

test('changing the B-F6 descriptor-derived generatedAt has NO EQUIVALENT FIELD in this schema, so an identical rebuild is byte-identical -- proves generatedAt never contaminates the checksum', () => {
  // Certification content payload has no generatedAt-shaped field at all; rebuilding twice from identical inputs (simulating a re-generated B-F6 descriptor with a new generatedAt that never entered this payload) must be byte-identical.
  const a = buildResearchUnderlyingYearCertification(baseInput());
  const b = buildResearchUnderlyingYearCertification(baseInput());
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

// ---- B-M8-HIGH-02: authoritative March-7 proof semantic validator (construction boundary) ----

function marchProofWith(overrides: Partial<March7NoLookaheadProof>): March7NoLookaheadProof {
  return { ...MARCH7_PROOF, ...overrides };
}
function marchProofWithEntry(index: number, entryOverrides: Partial<March7NoLookaheadProofEntry>): March7NoLookaheadProof {
  return { ...MARCH7_PROOF, entries: MARCH7_PROOF.entries.map((entry, i) => (i === index ? { ...entry, ...entryOverrides } : entry)) };
}

test('B-M8-HIGH-02: the exact locked correct March-7 proof is accepted at construction', () => {
  assert.doesNotThrow(() => buildResearchUnderlyingYearCertification(baseInput({ march7Proof: MARCH7_PROOF })));
});

test('B-M8-HIGH-02 construction: wrong tradingDate fails closed', () => {
  assert.throws(() => buildResearchUnderlyingYearCertification(baseInput({ march7Proof: marchProofWith({ tradingDate: '2022-03-08' }) })));
});

test('B-M8-HIGH-02 construction: wrong imputed-minute set (one minute replaced) fails closed', () => {
  assert.throws(() => buildResearchUnderlyingYearCertification(baseInput({ march7Proof: marchProofWith({ imputedMinutesIst: ['10:22', '10:23', '10:25'] }) })));
});

test('B-M8-HIGH-02 construction: wrong left real anchor fails closed', () => {
  assert.throws(() => buildResearchUnderlyingYearCertification(baseInput({ march7Proof: marchProofWith({ leftRealAnchorIst: '10:20' }) })));
});

test('B-M8-HIGH-02 construction: wrong right real anchor fails closed', () => {
  assert.throws(() => buildResearchUnderlyingYearCertification(baseInput({ march7Proof: marchProofWith({ rightRealAnchorIst: '10:26' }) })));
});

test('B-M8-HIGH-02 construction: wrong 2m 10:21-10:22 bucket availableAt fails closed', () => {
  assert.throws(() => buildResearchUnderlyingYearCertification(baseInput({ march7Proof: marchProofWithEntry(0, { expectedAvailableAtIst: '10:27' }) })));
});

test('B-M8-HIGH-02 construction: wrong 2m 10:23-10:24 bucket availableAt fails closed', () => {
  assert.throws(() => buildResearchUnderlyingYearCertification(baseInput({ march7Proof: marchProofWithEntry(1, { expectedAvailableAtIst: '10:27' }) })));
});

test('B-M8-HIGH-02 construction: wrong 3m 10:21-10:23 bucket availableAt fails closed', () => {
  assert.throws(() => buildResearchUnderlyingYearCertification(baseInput({ march7Proof: marchProofWithEntry(2, { expectedAvailableAtIst: '10:27' }) })));
});

test('B-M8-HIGH-02 construction: CRITICAL -- 3m 10:24-10:26 availableAt=10:26 (true value is 10:27) fails closed', () => {
  assert.throws(() => buildResearchUnderlyingYearCertification(baseInput({ march7Proof: marchProofWithEntry(3, { expectedAvailableAtIst: '10:26' }) })));
});

test('B-M8-HIGH-02 construction: wrong 5m 10:20-10:24 bucket availableAt fails closed', () => {
  assert.throws(() => buildResearchUnderlyingYearCertification(baseInput({ march7Proof: marchProofWithEntry(4, { expectedAvailableAtIst: '10:27' }) })));
});

test('B-M8-HIGH-02 construction: wrong target timeframe on an entry fails closed', () => {
  assert.throws(() => buildResearchUnderlyingYearCertification(baseInput({ march7Proof: marchProofWithEntry(4, { target: ResampleTargetTimeframe.TWO_MINUTE }) })));
});

test('B-M8-HIGH-02 construction: wrong bucketStartIst on an entry fails closed', () => {
  assert.throws(() => buildResearchUnderlyingYearCertification(baseInput({ march7Proof: marchProofWithEntry(0, { bucketStartIst: '10:22' }) })));
});

test('B-M8-HIGH-02 construction: verified=false on an entry fails closed', () => {
  assert.throws(() => buildResearchUnderlyingYearCertification(baseInput({ march7Proof: marchProofWithEntry(0, { verified: false }) })));
});

test('B-M8-HIGH-02 construction: a duplicate proof entry while omitting another (count still 5) fails closed', () => {
  const proof = marchProofWith({ entries: [MARCH7_PROOF.entries[0], MARCH7_PROOF.entries[0], MARCH7_PROOF.entries[2], MARCH7_PROOF.entries[3], MARCH7_PROOF.entries[4]] });
  assert.throws(() => buildResearchUnderlyingYearCertification(baseInput({ march7Proof: proof })));
});

test('B-M8-HIGH-02 construction: an extra unique entry beyond the locked 5 fails closed', () => {
  const proof = marchProofWith({ entries: [...MARCH7_PROOF.entries, { target: ResampleTargetTimeframe.TWO_MINUTE, bucketStartIst: '10:25', expectedAvailableAtIst: '10:26', verified: true }] });
  assert.throws(() => buildResearchUnderlyingYearCertification(baseInput({ march7Proof: proof })));
});

test('B-M8-HIGH-02 construction: a missing expected entry fails closed', () => {
  const proof = marchProofWith({ entries: MARCH7_PROOF.entries.slice(0, 4) });
  assert.throws(() => buildResearchUnderlyingYearCertification(baseInput({ march7Proof: proof })));
});

// ---- B-M8-HIGH-02: read boundary rejects a SELF-CONSISTENT (recomputed checksum) but semantically FALSE proof ----

/** Simulates a hand-authored/corrupted stored artifact that never went through `buildResearchUnderlyingYearCertification`'s construction-boundary guard: recomputes `certificationContentChecksum` over the TAMPERED payload so the resulting file is fully self-consistent (its own checksum matches its own content) -- proving the read-time semantic validator, not merely a checksum mismatch, is what rejects it. */
function selfConsistentTamperedCertification(base: ResearchUnderlyingYearCertificationV1, march7ProofOverrides: Partial<March7NoLookaheadProof>): ResearchUnderlyingYearCertificationV1 {
  const baseProof = base.march7Proof;
  if (baseProof === null) throw new Error('selfConsistentTamperedCertification: base.march7Proof is null -- this helper only tampers an existing non-null proof');
  const tamperedProof: March7NoLookaheadProof = { ...baseProof, ...march7ProofOverrides };
  const payload = {
    schemaVersion: base.schemaVersion,
    certificationSemanticsVersion: base.certificationSemanticsVersion,
    identity: base.identity,
    calendar: base.calendar,
    canonicalManifest: base.canonicalManifest,
    physicalStorage: base.physicalStorage,
    derivedSnapshotChecksum: base.derivedSnapshotChecksum,
    derivedSessionChecksum: base.derivedSessionChecksum,
    sourceAssemblyChecksum: base.sourceAssemblyChecksum,
    resamplingManifestChecksum: base.resamplingManifestChecksum,
    sessions: base.sessions,
    march7Proof: tamperedProof,
  };
  const certificationContentChecksum = computeResearchUnderlyingYearCertificationChecksum(payload);
  return { ...payload, summary: base.summary, certificationContentChecksum };
}

function writeForgedCertification(root: string, forged: ResearchUnderlyingYearCertificationV1): void {
  const absolutePath = join(root, researchUnderlyingYearCertificationRelativePath(forged.certificationContentChecksum));
  mkdirSync(join(absolutePath, '..'), { recursive: true });
  writeFileSync(absolutePath, JSON.stringify(forged, null, 2));
}

test('B-M8-HIGH-02 read boundary: a SELF-CONSISTENT forged artifact with the CRITICAL false 3m 10:24-10:26=10:26 availableAt fails closed', () => {
  const root = tempRoot();
  try {
    const certification = buildResearchUnderlyingYearCertification(baseInput());
    const march7Proof = certification.march7Proof as March7NoLookaheadProof;
    const forged = selfConsistentTamperedCertification(certification, {
      entries: march7Proof.entries.map((entry) => (entry.target === ResampleTargetTimeframe.THREE_MINUTE && entry.bucketStartIst === '10:24' ? { ...entry, expectedAvailableAtIst: '10:26' } : entry)),
    });
    writeForgedCertification(root, forged);
    assert.throws(() => readResearchUnderlyingYearCertification(root, forged.certificationContentChecksum), ResearchUnderlyingYearCertificationIntegrityError);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('B-M8-HIGH-02 read boundary: a SELF-CONSISTENT forged artifact with verified=false on one entry fails closed', () => {
  const root = tempRoot();
  try {
    const certification = buildResearchUnderlyingYearCertification(baseInput());
    const march7Proof = certification.march7Proof as March7NoLookaheadProof;
    const forged = selfConsistentTamperedCertification(certification, {
      entries: march7Proof.entries.map((entry, i) => (i === 0 ? { ...entry, verified: false } : entry)),
    });
    writeForgedCertification(root, forged);
    assert.throws(() => readResearchUnderlyingYearCertification(root, forged.certificationContentChecksum), ResearchUnderlyingYearCertificationIntegrityError);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('B-M8-HIGH-02 read boundary: a SELF-CONSISTENT forged artifact with a duplicate proof entry while omitting another fails closed', () => {
  const root = tempRoot();
  try {
    const certification = buildResearchUnderlyingYearCertification(baseInput());
    const entries = (certification.march7Proof as March7NoLookaheadProof).entries;
    const forged = selfConsistentTamperedCertification(certification, { entries: [entries[0], entries[0], entries[2], entries[3], entries[4]] });
    writeForgedCertification(root, forged);
    assert.throws(() => readResearchUnderlyingYearCertification(root, forged.certificationContentChecksum), ResearchUnderlyingYearCertificationIntegrityError);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- content-addressed store ----

test('first store is a new write; second identical store is a verified idempotent reuse', () => {
  const root = tempRoot();
  try {
    const certification = buildResearchUnderlyingYearCertification(baseInput());
    const first = storeResearchUnderlyingYearCertification(root, certification);
    assert.equal(first.wasNewlyWritten, true);
    const second = storeResearchUnderlyingYearCertification(root, certification);
    assert.equal(second.wasNewlyWritten, false);
    assert.equal(first.relativePath, researchUnderlyingYearCertificationRelativePath(certification.certificationContentChecksum));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('two builds at different wall clocks produce byte-identical stored JSON, and no generatedAt/UUID/path field exists', () => {
  const rootA = tempRoot();
  const rootB = tempRoot();
  try {
    const certA = buildResearchUnderlyingYearCertification(baseInput());
    const storedA = storeResearchUnderlyingYearCertification(rootA, certA);
    const bytesA = readFileSync(storedA.absolutePath, 'utf8');

    const certB = buildResearchUnderlyingYearCertification(baseInput());
    const storedB = storeResearchUnderlyingYearCertification(rootB, certB);
    const bytesB = readFileSync(storedB.absolutePath, 'utf8');

    assert.equal(bytesA, bytesB);
    assert.equal(/generatedAt/i.test(bytesA), false);
    assert.equal(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(bytesA), false);
    assert.equal(/[A-Z]:\\|\/tmp\/|\/home\//i.test(bytesA), false);
  } finally {
    rmSync(rootA, { recursive: true, force: true });
    rmSync(rootB, { recursive: true, force: true });
  }
});

// ---- read-time integrity ----

test('reading back a stored certification re-verifies checksum/duplicates/target-set/summary/march7Proof', () => {
  const root = tempRoot();
  try {
    const certification = buildResearchUnderlyingYearCertification(baseInput());
    storeResearchUnderlyingYearCertification(root, certification);
    const readBack = readResearchUnderlyingYearCertification(root, certification.certificationContentChecksum);
    assert.equal(readBack.certificationContentChecksum, certification.certificationContentChecksum);
    assert.deepEqual(readBack.summary, certification.summary);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a tampered stored summary (sessions unchanged) fails closed on read', () => {
  const root = tempRoot();
  try {
    const certification = buildResearchUnderlyingYearCertification(baseInput());
    const stored = storeResearchUnderlyingYearCertification(root, certification);
    const tampered = { ...certification, summary: { ...certification.summary, verifiedSessions: 999 } };
    writeFileSync(stored.absolutePath, JSON.stringify(tampered, null, 2));
    assert.throws(() => readResearchUnderlyingYearCertification(root, certification.certificationContentChecksum), ResearchUnderlyingYearCertificationIntegrityError);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a malformed March-7 proof (wrong imputed minutes) fails closed on read', () => {
  const root = tempRoot();
  try {
    const certification = buildResearchUnderlyingYearCertification(baseInput());
    const stored = storeResearchUnderlyingYearCertification(root, certification);
    const tampered = { ...certification, march7Proof: { ...certification.march7Proof, imputedMinutesIst: ['10:21', '10:22', '10:23'] } };
    writeFileSync(stored.absolutePath, JSON.stringify(tampered, null, 2));
    assert.throws(() => readResearchUnderlyingYearCertification(root, certification.certificationContentChecksum), ResearchUnderlyingYearCertificationIntegrityError);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a duplicate session date injected after storage (raw file tamper) fails closed on read', () => {
  const root = tempRoot();
  try {
    const certification = buildResearchUnderlyingYearCertification(baseInput());
    const stored = storeResearchUnderlyingYearCertification(root, certification);
    const tampered = { ...certification, sessions: [certification.sessions[0], certification.sessions[0], certification.sessions[1], certification.sessions[2]] };
    writeFileSync(stored.absolutePath, JSON.stringify(tampered, null, 2));
    assert.throws(() => readResearchUnderlyingYearCertification(root, certification.certificationContentChecksum), ResearchUnderlyingYearCertificationIntegrityError);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ============================================================================
// B-M9: clean-canonical-year (zero authorized-derived sessions) generalization
// ============================================================================

test('B-M9: a clean 0-derived candidate is accepted at construction, all three derived-specific fields explicit null', () => {
  const certification = buildResearchUnderlyingYearCertification(cleanYearBaseInput());
  assert.equal(certification.derivedSnapshotChecksum, null);
  assert.equal(certification.derivedSessionChecksum, null);
  assert.equal(certification.march7Proof, null);
  assert.equal(certification.summary.authorizedDerivedSessions, 0);
});

test('B-M9: clean candidate serializes explicit null (not omitted) for all three derived-specific fields', () => {
  const certification = buildResearchUnderlyingYearCertification(cleanYearBaseInput());
  const roundTripped = JSON.parse(JSON.stringify(certification));
  assert.ok('derivedSnapshotChecksum' in roundTripped);
  assert.ok('derivedSessionChecksum' in roundTripped);
  assert.ok('march7Proof' in roundTripped);
  assert.equal(roundTripped.derivedSnapshotChecksum, null);
  assert.equal(roundTripped.derivedSessionChecksum, null);
  assert.equal(roundTripped.march7Proof, null);
});

test('B-M9: clean candidate checksum is deterministic across identical rebuilds', () => {
  const a = buildResearchUnderlyingYearCertification(cleanYearBaseInput());
  const b = buildResearchUnderlyingYearCertification(cleanYearBaseInput());
  assert.equal(a.certificationContentChecksum, b.certificationContentChecksum);
});

test('B-M9: existing 1-derived March7 topology still requires and accepts all three non-null fields, exhaustive validator still runs', () => {
  const certification = buildResearchUnderlyingYearCertification(baseInput());
  assert.notEqual(certification.derivedSnapshotChecksum, null);
  assert.notEqual(certification.derivedSessionChecksum, null);
  assert.notEqual(certification.march7Proof, null);
  assert.equal(certification.summary.authorizedDerivedSessions, 1);
});

// ---- B-M9 construction-boundary: mixed/incoherent null combinations fail closed ----

test('B-M9 construction: 0 derived + non-null derivedSnapshotChecksum (session/proof null) fails closed', () => {
  assert.throws(() => buildResearchUnderlyingYearCertification(cleanYearBaseInput({ derivedSnapshotChecksum: 'a'.repeat(64) })), /authorizedDerivedSessions=0/);
});

test('B-M9 construction: 0 derived + non-null derivedSessionChecksum (snapshot/proof null) fails closed', () => {
  assert.throws(() => buildResearchUnderlyingYearCertification(cleanYearBaseInput({ derivedSessionChecksum: 'b'.repeat(64) })), /authorizedDerivedSessions=0/);
});

test('B-M9 construction: 0 derived + non-null march7Proof (snapshot/session null) fails closed -- proof present with 0 derived is rejected', () => {
  assert.throws(() => buildResearchUnderlyingYearCertification(cleanYearBaseInput({ march7Proof: MARCH7_PROOF })), /authorizedDerivedSessions=0/);
});

test('B-M9 construction: 1 derived + null derivedSnapshotChecksum (session/proof non-null) fails closed', () => {
  assert.throws(() => buildResearchUnderlyingYearCertification(baseInput({ derivedSnapshotChecksum: null })), /authorizedDerivedSessions=1/);
});

test('B-M9 construction: 1 derived + null derivedSessionChecksum (snapshot/proof non-null) fails closed', () => {
  assert.throws(() => buildResearchUnderlyingYearCertification(baseInput({ derivedSessionChecksum: null })), /authorizedDerivedSessions=1/);
});

test('B-M9 construction: 1 derived + null march7Proof (snapshot/session non-null) fails closed -- null proof with derived topology is rejected', () => {
  assert.throws(() => buildResearchUnderlyingYearCertification(baseInput({ march7Proof: null })), /authorizedDerivedSessions=1/);
});

test('B-M9 construction: 2 authorized-derived sessions is not representable by the existing March7 proof model and fails closed', () => {
  const twoTier3Sessions = [
    sessionRecord('2022-01-03'),
    sessionRecord('2022-03-07', ResearchSessionSourcePrecedenceTier.AUTHORIZED_DERIVED_IMPUTED_SESSION),
    sessionRecord('2022-09-15', ResearchSessionSourcePrecedenceTier.AUTHORIZED_DERIVED_IMPUTED_SESSION),
  ];
  assert.throws(() => buildResearchUnderlyingYearCertification(baseInput({ sessions: twoTier3Sessions })), /not representable by the existing trusted March-7 proof model/);
});

// ---- B-M9 read-boundary: self-consistent (recomputed checksum) forged variants fail closed ----

/** Forges a certification's checksummed payload (sessions and/or the three derived-specific fields), recomputing BOTH `certificationContentChecksum` AND `summary` from the forged content so the artifact is FULLY self-consistent -- isolating the derived-topology coherence check as the ONLY thing that can reject it (never an incidental summary/checksum mismatch). */
function selfConsistentForgedCertification(base: ResearchUnderlyingYearCertificationV1, overrides: Partial<Pick<ResearchUnderlyingYearCertificationV1, 'sessions' | 'derivedSnapshotChecksum' | 'derivedSessionChecksum' | 'march7Proof'>>): ResearchUnderlyingYearCertificationV1 {
  const payload = {
    schemaVersion: base.schemaVersion,
    certificationSemanticsVersion: base.certificationSemanticsVersion,
    identity: base.identity,
    calendar: base.calendar,
    canonicalManifest: base.canonicalManifest,
    physicalStorage: base.physicalStorage,
    derivedSnapshotChecksum: base.derivedSnapshotChecksum,
    derivedSessionChecksum: base.derivedSessionChecksum,
    sourceAssemblyChecksum: base.sourceAssemblyChecksum,
    resamplingManifestChecksum: base.resamplingManifestChecksum,
    sessions: base.sessions,
    march7Proof: base.march7Proof,
    ...overrides,
  };
  const certificationContentChecksum = computeResearchUnderlyingYearCertificationChecksum(payload);
  const summary = deriveResearchUnderlyingYearCertificationSummary(payload.sessions, payload.calendar.expectedSessionCount);
  return { ...payload, summary, certificationContentChecksum };
}

test('B-M9 read boundary: a self-consistent forged artifact claiming authorizedDerivedSessions=0 while RETAINING non-null derived proof/checksum fails closed', () => {
  const root = tempRoot();
  try {
    const validMarch7Cert = buildResearchUnderlyingYearCertification(baseInput());
    const allTier1Sessions = [sessionRecord('2022-01-03'), sessionRecord('2022-01-04')];
    const forged = selfConsistentForgedCertification(validMarch7Cert, { sessions: allTier1Sessions });
    const absolutePath = join(root, researchUnderlyingYearCertificationRelativePath(forged.certificationContentChecksum));
    mkdirSync(join(absolutePath, '..'), { recursive: true });
    writeFileSync(absolutePath, JSON.stringify(forged, null, 2));
    assert.throws(() => readResearchUnderlyingYearCertification(root, forged.certificationContentChecksum), ResearchUnderlyingYearCertificationIntegrityError);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('B-M9 read boundary: a self-consistent forged artifact claiming derived sessions > 0 while all proof/checksum fields stay null fails closed', () => {
  const root = tempRoot();
  try {
    const validCleanCert = buildResearchUnderlyingYearCertification(cleanYearBaseInput());
    const oneTier3Session = [sessionRecord('2023-01-02'), sessionRecord('2023-01-03', ResearchSessionSourcePrecedenceTier.AUTHORIZED_DERIVED_IMPUTED_SESSION)];
    const forged = selfConsistentForgedCertification(validCleanCert, { sessions: oneTier3Session });
    const absolutePath = join(root, researchUnderlyingYearCertificationRelativePath(forged.certificationContentChecksum));
    mkdirSync(join(absolutePath, '..'), { recursive: true });
    writeFileSync(absolutePath, JSON.stringify(forged, null, 2));
    assert.throws(() => readResearchUnderlyingYearCertification(root, forged.certificationContentChecksum), ResearchUnderlyingYearCertificationIntegrityError);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('B-M9 read boundary: a self-consistent forged artifact with a PARTIAL null combination (1 derived session, derivedSnapshotChecksum forced null) fails closed', () => {
  const root = tempRoot();
  try {
    const validMarch7Cert = buildResearchUnderlyingYearCertification(baseInput());
    const forged = selfConsistentForgedCertification(validMarch7Cert, { derivedSnapshotChecksum: null });
    const absolutePath = join(root, researchUnderlyingYearCertificationRelativePath(forged.certificationContentChecksum));
    mkdirSync(join(absolutePath, '..'), { recursive: true });
    writeFileSync(absolutePath, JSON.stringify(forged, null, 2));
    assert.throws(() => readResearchUnderlyingYearCertification(root, forged.certificationContentChecksum), ResearchUnderlyingYearCertificationIntegrityError);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('B-M9 read boundary: a self-consistent forged artifact with a PARTIAL null combination (1 derived session, march7Proof forced null, checksums retained) fails closed', () => {
  const root = tempRoot();
  try {
    const validMarch7Cert = buildResearchUnderlyingYearCertification(baseInput());
    const forged = selfConsistentForgedCertification(validMarch7Cert, { march7Proof: null });
    const absolutePath = join(root, researchUnderlyingYearCertificationRelativePath(forged.certificationContentChecksum));
    mkdirSync(join(absolutePath, '..'), { recursive: true });
    writeFileSync(absolutePath, JSON.stringify(forged, null, 2));
    assert.throws(() => readResearchUnderlyingYearCertification(root, forged.certificationContentChecksum), ResearchUnderlyingYearCertificationIntegrityError);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- B-M9: 2022 committed artifact byte/checksum regression (read-only, real committed file) ----

const REAL_COMMITTED_2022_CERTIFICATION_CHECKSUM = '48a4c1734368eaeb4580133b3bd8e87649f8f13130c67843eb6d5ca3f83acd71';

test('B-M9: the real committed 2022 certification artifact is still accepted by the reader (read-only, no production CLI run)', () => {
  const readBack = readResearchUnderlyingYearCertification(RESEARCH_UNDERLYING_YEAR_CERTIFICATION_STORAGE_ROOT, REAL_COMMITTED_2022_CERTIFICATION_CHECKSUM);
  assert.equal(readBack.certificationContentChecksum, REAL_COMMITTED_2022_CERTIFICATION_CHECKSUM);
  assert.equal(readBack.identity.year, 2022);
  assert.equal(readBack.summary.expectedSessions, 248);
  assert.equal(readBack.summary.realCanonicalSessions, 247);
  assert.equal(readBack.summary.authorizedDerivedSessions, 1);
  assert.notEqual(readBack.derivedSnapshotChecksum, null);
  assert.notEqual(readBack.derivedSessionChecksum, null);
  assert.notEqual(readBack.march7Proof, null);
});

test('B-M9: rebuilding the real committed 2022 certification content (read back, then re-run through the SAME builder) reproduces EXACTLY the locked checksum', () => {
  const readBack = readResearchUnderlyingYearCertification(RESEARCH_UNDERLYING_YEAR_CERTIFICATION_STORAGE_ROOT, REAL_COMMITTED_2022_CERTIFICATION_CHECKSUM);
  const rebuilt = buildResearchUnderlyingYearCertification({
    schemaVersion: readBack.schemaVersion,
    certificationSemanticsVersion: readBack.certificationSemanticsVersion,
    identity: readBack.identity,
    calendar: readBack.calendar,
    canonicalManifest: readBack.canonicalManifest,
    physicalStorage: readBack.physicalStorage,
    derivedSnapshotChecksum: readBack.derivedSnapshotChecksum,
    derivedSessionChecksum: readBack.derivedSessionChecksum,
    sourceAssemblyChecksum: readBack.sourceAssemblyChecksum,
    resamplingManifestChecksum: readBack.resamplingManifestChecksum,
    sessions: readBack.sessions,
    march7Proof: readBack.march7Proof,
  });
  assert.equal(rebuilt.certificationContentChecksum, REAL_COMMITTED_2022_CERTIFICATION_CHECKSUM);
});
