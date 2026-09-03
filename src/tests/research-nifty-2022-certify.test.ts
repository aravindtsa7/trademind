import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ResearchSessionSourcePrecedenceTier } from '../modules/research-lake/domain/derived-imputed-research-session.types';
import { ResampleTargetTimeframe } from '../modules/research-lake/domain/resampled-candle.types';
import { ManifestDatasetKind } from '../modules/research-lake/domain/dataset-manifest.types';
import { ParquetCompressionCodec, ParquetWriterFormat } from '../modules/research-lake/domain/parquet-storage.types';
import {
  CertifiedSessionRecord,
  CertifiedSessionTargetRecord,
  March7NoLookaheadProof,
  RESEARCH_UNDERLYING_YEAR_CERTIFICATION_SCHEMA_VERSION,
  RESEARCH_UNDERLYING_YEAR_CERTIFICATION_SEMANTICS_VERSION,
  buildResearchUnderlyingYearCertification,
} from '../modules/research-lake/domain/research-underlying-year-certification.types';
import { ContentAddressedJsonStoreResult } from '../modules/research-lake/domain/content-addressed-json-store';
import { CertifyYear, RunCertifyOptions, runNifty2022Certify } from './research-nifty-2022-certify';
import { CertifyYearRequest, CertifyYearResult } from '../modules/research-lake/services/nifty-underlying-research-certification.service';

const LOCKED_CANONICAL_DATASET_CHECKSUM = '1a7cf5e2f88a0f6bee8b687f92c80c291a8a7bcb15184b986639f431a76e5870';
const LOCKED_SOURCE_ASSEMBLY_CHECKSUM = '8506497dfdb15f4a1e7da08d43e64a6a21928252e251312c771d7195ba19ecdb';
const LOCKED_RESAMPLING_MANIFEST_CHECKSUM = '3881dc81c685ae16f60869f6faed2f9d9ebbf7a4ac5cafe89af7a9a33be3dd3b';
const MARCH_7_DATE = '2022-03-07';

function captureOutput() {
  const lines: string[] = [];
  const errorLines: string[] = [];
  return { lines, errorLines, output: (line: string) => lines.push(line), errorOutput: (line: string) => errorLines.push(line) };
}

class FakeCertificationService implements CertifyYear {
  public certifyCallCount = 0;
  public persistCallCount = 0;
  constructor(
    private readonly resultOrError: CertifyYearResult | Error,
    private readonly persistResultOrError?: ContentAddressedJsonStoreResult | Error
  ) {}
  async certifyYear(_request: CertifyYearRequest): Promise<CertifyYearResult> {
    this.certifyCallCount += 1;
    if (this.resultOrError instanceof Error) throw this.resultOrError;
    return this.resultOrError;
  }
  persistCertification(certification: CertifyYearResult['certification']): ContentAddressedJsonStoreResult {
    this.persistCallCount += 1;
    const outcome = this.persistResultOrError ?? { relativePath: `research-underlying-certifications/${certification.certificationContentChecksum}.json`, absolutePath: `/tmp/${certification.certificationContentChecksum}.json`, wasNewlyWritten: true };
    if (outcome instanceof Error) throw outcome;
    return outcome;
  }
}

function genericTargetRecord(target: ResampleTargetTimeframe): CertifiedSessionTargetRecord {
  return { target, researchDerivedContentChecksum: 'r'.repeat(64), outputCandleCount: 100, structuralTrailingRowCount: 0, candlesContainingImputation: 0, noLookaheadVerified: true };
}

function genericSessionRecord(tradingDate: string): CertifiedSessionRecord {
  return {
    tradingDate,
    calendarSessionWindows: [{ windowIndex: 0, openMinuteIst: 555, closeMinuteIst: 930 }],
    sourcePrecedenceTier: ResearchSessionSourcePrecedenceTier.HEALTHY_REAL_CANONICAL_SESSION,
    sourceContentChecksum: 'c'.repeat(64),
    sourceRowCount: 375,
    realCanonicalRowCount: 375,
    derivedObservedRowCount: 0,
    derivedImputedRowCount: 0,
    oneMinuteVerificationChecksum: 'v'.repeat(64),
    targets: [genericTargetRecord(ResampleTargetTimeframe.TWO_MINUTE), genericTargetRecord(ResampleTargetTimeframe.THREE_MINUTE), genericTargetRecord(ResampleTargetTimeframe.FIVE_MINUTE)],
  };
}

const CORRECT_MARCH7_PROOF: March7NoLookaheadProof = {
  tradingDate: MARCH_7_DATE,
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

function sequentialDates(count: number, startIsoDate: string): string[] {
  const start = new Date(`${startIsoDate}T00:00:00.000Z`);
  return Array.from({ length: count }, (_, i) => new Date(start.getTime() + i * 86_400_000).toISOString().slice(0, 10));
}

function fullyValidResult(overrides: { sessions?: CertifiedSessionRecord[] } = {}): CertifyYearResult {
  const genericDates = sequentialDates(247, '2020-01-01');
  const march7Session: CertifiedSessionRecord = {
    ...genericSessionRecord(MARCH_7_DATE),
    sourcePrecedenceTier: ResearchSessionSourcePrecedenceTier.AUTHORIZED_DERIVED_IMPUTED_SESSION,
    realCanonicalRowCount: 0,
    derivedObservedRowCount: 372,
    derivedImputedRowCount: 3,
  };
  const sessions = overrides.sessions ?? [...genericDates.map((d) => genericSessionRecord(d)), march7Session];

  const certification = buildResearchUnderlyingYearCertification({
    schemaVersion: RESEARCH_UNDERLYING_YEAR_CERTIFICATION_SCHEMA_VERSION,
    certificationSemanticsVersion: RESEARCH_UNDERLYING_YEAR_CERTIFICATION_SEMANTICS_VERSION,
    identity: { instrumentKey: 'NSE_INDEX|Nifty 50', sourceTimeframe: '1minute', year: 2022 },
    calendar: { expectedSessionCount: 248 },
    canonicalManifest: { datasetId: 'UNDERLYING_1M_abc', datasetChecksum: LOCKED_CANONICAL_DATASET_CHECKSUM, manifestSchemaVersion: 5, canonicalizationVersion: 1, healthSemanticsVersion: 1 },
    physicalStorage: {
      storageSchemaVersion: 1,
      datasetId: 'UNDERLYING_1M_abc',
      datasetChecksum: LOCKED_CANONICAL_DATASET_CHECKSUM,
      datasetKind: ManifestDatasetKind.UNDERLYING_1M,
      writerFormat: ParquetWriterFormat.PARQUET,
      writerLibrary: 'hyparquet-writer',
      writerLibraryVersion: '0.16.6',
      compressionCodec: ParquetCompressionCodec.SNAPPY,
      sessions: genericDates.map((d) => ({ tradingDate: d, sessionContentChecksum: 'c'.repeat(64), canonicalRowCount: 375, physicalFileChecksum: 'p'.repeat(64) })),
    },
    derivedSnapshotChecksum: 'a'.repeat(64),
    derivedSessionChecksum: 'b'.repeat(64),
    sourceAssemblyChecksum: LOCKED_SOURCE_ASSEMBLY_CHECKSUM,
    resamplingManifestChecksum: LOCKED_RESAMPLING_MANIFEST_CHECKSUM,
    sessions,
    march7Proof: CORRECT_MARCH7_PROOF,
  });

  // Overwrite the (session-derived) byTarget totals with the exact locked 2022 aggregate values -- the CLI only re-checks `summary`, never re-derives it from session records itself.
  const patchedCertification = {
    ...certification,
    summary: {
      ...certification.summary,
      byTarget: {
        [ResampleTargetTimeframe.TWO_MINUTE]: { sessionCount: 248, completeSessionCount: 248, totalOutputCandles: 46219, totalStructuralTrailingRows: 247, totalCandlesContainingImputation: 2 },
        [ResampleTargetTimeframe.THREE_MINUTE]: { sessionCount: 248, completeSessionCount: 248, totalOutputCandles: 30895, totalStructuralTrailingRows: 0, totalCandlesContainingImputation: 2 },
        [ResampleTargetTimeframe.FIVE_MINUTE]: { sessionCount: 248, completeSessionCount: 248, totalOutputCandles: 18537, totalStructuralTrailingRows: 0, totalCandlesContainingImputation: 1 },
      },
    },
  };

  return {
    certification: patchedCertification,
    canonicalManifest: {} as never,
    sourceAssembly: {} as never,
    resamplingManifest: {} as never,
  };
}

async function run(service: CertifyYear): Promise<{ success: boolean; lines: string[]; errorLines: string[] }> {
  const { lines, errorLines, output, errorOutput } = captureOutput();
  const success = await runNifty2022Certify({ buildService: () => service, output, errorOutput } as RunCertifyOptions);
  return { success, lines, errorLines };
}

// ---- happy path ----

test('A. exact locked postconditions -> SUCCESS, persisted exactly once', async () => {
  const service = new FakeCertificationService(fullyValidResult());
  const { success, lines, errorLines } = await run(service);
  assert.equal(success, true);
  assert.equal(errorLines.length, 0);
  assert.equal(service.persistCallCount, 1);
  const summary = lines.join('\n');
  assert.ok(summary.includes('status=SUCCESS'));
  assert.ok(summary.includes('expectedSessions=248'));
  assert.ok(summary.includes('verifiedSessions=248'));
  assert.ok(summary.includes('march7NoLookaheadProofsVerified=true'));
});

// ---- checksum bindings ----

test('B. wrong canonical checksum -> FAILED, no persist', async () => {
  const base = fullyValidResult();
  const service = new FakeCertificationService({ ...base, certification: { ...base.certification, canonicalManifest: { ...base.certification.canonicalManifest, datasetChecksum: '0'.repeat(64) } } });
  const { success, errorLines } = await run(service);
  assert.equal(success, false);
  assert.equal(service.persistCallCount, 0);
  assert.ok(errorLines.join('\n').includes('code=WRONG_CANONICAL_CHECKSUM'));
});

test('C. wrong B-M7.2 source assembly checksum -> FAILED, no persist', async () => {
  const base = fullyValidResult();
  const service = new FakeCertificationService({ ...base, certification: { ...base.certification, sourceAssemblyChecksum: '9'.repeat(64) } });
  const { success, errorLines } = await run(service);
  assert.equal(success, false);
  assert.ok(errorLines.join('\n').includes('code=WRONG_SOURCE_ASSEMBLY_CHECKSUM'));
});

test('D. wrong B-M7.3 resampling manifest checksum -> FAILED, no persist', async () => {
  const base = fullyValidResult();
  const service = new FakeCertificationService({ ...base, certification: { ...base.certification, resamplingManifestChecksum: '9'.repeat(64) } });
  const { success, errorLines } = await run(service);
  assert.equal(success, false);
  assert.ok(errorLines.join('\n').includes('code=WRONG_RESAMPLING_MANIFEST_CHECKSUM'));
});

// ---- session-count postconditions ----

test('E. session count !== 248 -> FAILED, no persist', async () => {
  const base = fullyValidResult();
  const service = new FakeCertificationService({ ...base, certification: { ...base.certification, summary: { ...base.certification.summary, verifiedSessions: 200 } } });
  const { success, errorLines } = await run(service);
  assert.equal(success, false);
  assert.ok(errorLines.join('\n').includes('code=WRONG_SESSION_COUNT'));
});

test('F. unavailable sessions present -> FAILED, no persist', async () => {
  const base = fullyValidResult();
  const service = new FakeCertificationService({ ...base, certification: { ...base.certification, summary: { ...base.certification.summary, unavailableSessions: 1 } } });
  const { success, errorLines } = await run(service);
  assert.equal(success, false);
  assert.ok(errorLines.join('\n').includes('code=UNAVAILABLE_SESSIONS_PRESENT'));
});

test('G. a session with an unverified no-lookahead target fails -> FAILED, no persist', async () => {
  const genericDates = sequentialDates(246, '2020-01-01');
  const march7Session: CertifiedSessionRecord = { ...genericSessionRecord(MARCH_7_DATE), sourcePrecedenceTier: ResearchSessionSourcePrecedenceTier.AUTHORIZED_DERIVED_IMPUTED_SESSION, realCanonicalRowCount: 0, derivedObservedRowCount: 372, derivedImputedRowCount: 3 };
  const badSession: CertifiedSessionRecord = { ...genericSessionRecord('2021-12-31'), targets: [{ ...genericTargetRecord(ResampleTargetTimeframe.TWO_MINUTE), noLookaheadVerified: false }, genericTargetRecord(ResampleTargetTimeframe.THREE_MINUTE), genericTargetRecord(ResampleTargetTimeframe.FIVE_MINUTE)] };
  const base = fullyValidResult({ sessions: [...genericDates.map((d) => genericSessionRecord(d)), badSession, march7Session] });
  const service = new FakeCertificationService(base);
  const { success, errorLines } = await run(service);
  assert.equal(success, false);
  assert.ok(errorLines.join('\n').includes('code=NO_LOOKAHEAD_NOT_VERIFIED'));
});

// ---- aggregate totals ----

test('H. wrong 2m aggregate totals -> FAILED, no persist', async () => {
  const base = fullyValidResult();
  const service = new FakeCertificationService({ ...base, certification: { ...base.certification, summary: { ...base.certification.summary, byTarget: { ...base.certification.summary.byTarget, [ResampleTargetTimeframe.TWO_MINUTE]: { ...base.certification.summary.byTarget[ResampleTargetTimeframe.TWO_MINUTE], totalOutputCandles: 999 } } } } });
  const { success, errorLines } = await run(service);
  assert.equal(success, false);
  assert.ok(errorLines.join('\n').includes('code=WRONG_TARGET_AGGREGATE_TOTALS'));
});

// ---- March-7 proofs ----

// Note: buildResearchUnderlyingYearCertification now REJECTS a semantically false march7Proof at
// construction time (B-M8-HIGH-02 fix) -- a real service can never produce a CertifyYearResult
// carrying a false proof. These tests still verify the CLI's own redundant postcondition check as
// defense-in-depth (in case a future/fake service implementation regresses this), by tampering the
// ALREADY-BUILT valid certification directly -- never by asking the builder to accept a bad proof.

test('I. wrong March-7 imputed minutes -> FAILED, no persist', async () => {
  const base = fullyValidResult();
  const service = new FakeCertificationService({ ...base, certification: { ...base.certification, march7Proof: { ...base.certification.march7Proof, imputedMinutesIst: ['10:21', '10:22', '10:23'] } } });
  const { success, errorLines } = await run(service);
  assert.equal(success, false);
  assert.ok(errorLines.join('\n').includes('code=WRONG_MARCH7_IMPUTED_MINUTES'));
});

test('J. the 3m 10:24-10:26 proof reporting 10:26 instead of the required 10:27 fails closed', async () => {
  const base = fullyValidResult();
  const tamperedEntries = base.certification.march7Proof.entries.map((entry) => (entry.target === ResampleTargetTimeframe.THREE_MINUTE && entry.bucketStartIst === '10:24' ? { ...entry, expectedAvailableAtIst: '10:26' } : entry));
  const service = new FakeCertificationService({ ...base, certification: { ...base.certification, march7Proof: { ...base.certification.march7Proof, entries: tamperedEntries } } });
  const { success, errorLines } = await run(service);
  assert.equal(success, false);
  assert.ok(errorLines.join('\n').includes('code=MARCH7_NO_LOOKAHEAD_PROOF_FAILED'));
});

test('K. a march7Proof entry marked verified=false fails closed', async () => {
  const base = fullyValidResult();
  const tamperedEntries = base.certification.march7Proof.entries.map((entry, i) => (i === 0 ? { ...entry, verified: false } : entry));
  const service = new FakeCertificationService({ ...base, certification: { ...base.certification, march7Proof: { ...base.certification.march7Proof, entries: tamperedEntries } } });
  const { success, errorLines } = await run(service);
  assert.equal(success, false);
  assert.ok(errorLines.join('\n').includes('code=MARCH7_NO_LOOKAHEAD_PROOF_FAILED'));
});

// ---- exceptions ----

test('L. certifyYear throws -> FAILED, non-zero, no persist attempted', async () => {
  const service = new FakeCertificationService(new Error('canonical Parquet storage is UNMATERIALIZED'));
  const { success, lines, errorLines } = await run(service);
  assert.equal(success, false);
  assert.equal(lines.length, 0);
  assert.equal(service.persistCallCount, 0);
  assert.ok(errorLines.join('\n').includes('canonical Parquet storage is UNMATERIALIZED'));
});

test('M. persistCertification throws even though every postcondition passed -> FAILED, non-zero, no SUCCESS', async () => {
  const service = new FakeCertificationService(fullyValidResult(), new Error('disk full'));
  const { success, lines, errorLines } = await run(service);
  assert.equal(success, false);
  assert.equal(lines.length, 0);
  assert.equal(service.persistCallCount, 1);
  assert.ok(errorLines.join('\n').includes('code=PERSISTENCE_FAILED'));
  assert.ok(errorLines.join('\n').includes('disk full'));
});

// ---- structural ----

test('structural: this CLI never reads process.env and never imports a provider client', () => {
  const source = readFileSync(join(__dirname, 'research-nifty-2022-certify.ts'), 'utf8');
  assert.equal(/process\.env/.test(source), false);
  assert.equal(/from\s+['"][^'"]*upstox[^'"]*['"]/i.test(source), false);
});

test('structural: this CLI never imports ResearchYearRunnerService (a doc-comment mention explaining it is out of scope is fine)', () => {
  const source = readFileSync(join(__dirname, 'research-nifty-2022-certify.ts'), 'utf8');
  assert.equal(/import[^;]*ResearchYearRunnerService/.test(source), false);
  assert.equal(/from\s+['"][^'"]*research-year-runner[^'"]*['"]/i.test(source), false);
});

test('structural: the CLI persists ONLY after postcondition validation -- in source order', () => {
  const source = readFileSync(join(__dirname, 'research-nifty-2022-certify.ts'), 'utf8');
  const validateIndex = source.indexOf('validateLockedPostconditions(result)');
  const persistIndex = source.indexOf('service.persistCertification(result.certification)');
  assert.ok(validateIndex > 0 && persistIndex > 0);
  assert.ok(validateIndex < persistIndex);
});

test('the service is called exactly once per run', async () => {
  const service = new FakeCertificationService(fullyValidResult());
  await run(service);
  assert.equal(service.certifyCallCount, 1);
  assert.equal(service.persistCallCount, 1);
});
