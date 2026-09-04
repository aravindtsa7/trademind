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
  RESEARCH_UNDERLYING_YEAR_CERTIFICATION_SCHEMA_VERSION,
  RESEARCH_UNDERLYING_YEAR_CERTIFICATION_SEMANTICS_VERSION,
  buildResearchUnderlyingYearCertification,
} from '../modules/research-lake/domain/research-underlying-year-certification.types';
import { ContentAddressedJsonStoreResult } from '../modules/research-lake/domain/content-addressed-json-store';
import { CertifyYear, RunNifty2023CertifyOptions, runNifty2023Certify } from './research-nifty-2023-certify';
import { CertifyYearRequest, CertifyYearResult } from '../modules/research-lake/services/nifty-underlying-research-certification.service';

const VALID_CANONICAL_CHECKSUM = 'a'.repeat(64);
const VALID_SOURCE_ASSEMBLY_CHECKSUM = 'b'.repeat(64);
const VALID_RESAMPLING_MANIFEST_CHECKSUM = 'c'.repeat(64);

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

function sequentialDates(count: number, startIsoDate: string): string[] {
  const start = new Date(`${startIsoDate}T00:00:00.000Z`);
  return Array.from({ length: count }, (_, i) => new Date(start.getTime() + i * 86_400_000).toISOString().slice(0, 10));
}

function fullyValidResult(overrides: { sessions?: CertifiedSessionRecord[] } = {}): CertifyYearResult {
  const genericDates = sequentialDates(246, '2020-01-01');
  const sessions = overrides.sessions ?? genericDates.map((d) => genericSessionRecord(d));

  const certification = buildResearchUnderlyingYearCertification({
    schemaVersion: RESEARCH_UNDERLYING_YEAR_CERTIFICATION_SCHEMA_VERSION,
    certificationSemanticsVersion: RESEARCH_UNDERLYING_YEAR_CERTIFICATION_SEMANTICS_VERSION,
    identity: { instrumentKey: 'NSE_INDEX|Nifty 50', sourceTimeframe: '1minute', year: 2023 },
    calendar: { expectedSessionCount: 246 },
    canonicalManifest: { datasetId: 'UNDERLYING_1M_xyz', datasetChecksum: VALID_CANONICAL_CHECKSUM, manifestSchemaVersion: 5, canonicalizationVersion: 1, healthSemanticsVersion: 1 },
    physicalStorage: {
      storageSchemaVersion: 1,
      datasetId: 'UNDERLYING_1M_xyz',
      datasetChecksum: VALID_CANONICAL_CHECKSUM,
      datasetKind: ManifestDatasetKind.UNDERLYING_1M,
      writerFormat: ParquetWriterFormat.PARQUET,
      writerLibrary: 'hyparquet-writer',
      writerLibraryVersion: '0.16.6',
      compressionCodec: ParquetCompressionCodec.SNAPPY,
      sessions: genericDates.map((d) => ({ tradingDate: d, sessionContentChecksum: 'c'.repeat(64), canonicalRowCount: 375, physicalFileChecksum: 'p'.repeat(64) })),
    },
    derivedSnapshotChecksum: null,
    derivedSessionChecksum: null,
    sourceAssemblyChecksum: VALID_SOURCE_ASSEMBLY_CHECKSUM,
    resamplingManifestChecksum: VALID_RESAMPLING_MANIFEST_CHECKSUM,
    sessions,
    march7Proof: null,
  });

  // Overwrite the (session-derived) byTarget totals with the exact locked 2023 aggregate values -- the CLI only re-checks `summary`, never re-derives it from session records itself.
  const patchedCertification = {
    ...certification,
    summary: {
      ...certification.summary,
      byTarget: {
        [ResampleTargetTimeframe.TWO_MINUTE]: { sessionCount: 246, completeSessionCount: 246, totalOutputCandles: 45845, totalStructuralTrailingRows: 245, totalCandlesContainingImputation: 0 },
        [ResampleTargetTimeframe.THREE_MINUTE]: { sessionCount: 246, completeSessionCount: 246, totalOutputCandles: 30645, totalStructuralTrailingRows: 0, totalCandlesContainingImputation: 0 },
        [ResampleTargetTimeframe.FIVE_MINUTE]: { sessionCount: 246, completeSessionCount: 246, totalOutputCandles: 18387, totalStructuralTrailingRows: 0, totalCandlesContainingImputation: 0 },
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

async function run(service: CertifyYear, checksums: { canonical?: string | undefined; assembly?: string | undefined; resampling?: string | undefined } = {}): Promise<{ success: boolean; lines: string[]; errorLines: string[] }> {
  const { lines, errorLines, output, errorOutput } = captureOutput();
  const success = await runNifty2023Certify({
    canonicalManifestChecksum: 'canonical' in checksums ? checksums.canonical : VALID_CANONICAL_CHECKSUM,
    sourceAssemblyChecksum: 'assembly' in checksums ? checksums.assembly : VALID_SOURCE_ASSEMBLY_CHECKSUM,
    resamplingManifestChecksum: 'resampling' in checksums ? checksums.resampling : VALID_RESAMPLING_MANIFEST_CHECKSUM,
    buildService: () => service,
    output,
    errorOutput,
  } as RunNifty2023CertifyOptions);
  return { success, lines, errorLines };
}

// ---- happy path ----

test('A. exact locked postconditions -> SUCCESS, persisted exactly once, no misleading march7 line', async () => {
  const service = new FakeCertificationService(fullyValidResult());
  const { success, lines, errorLines } = await run(service);
  assert.equal(success, true);
  assert.equal(errorLines.length, 0);
  assert.equal(service.persistCallCount, 1);
  const summary = lines.join('\n');
  assert.ok(summary.includes('status=SUCCESS'));
  assert.ok(summary.includes('expectedSessions=246'));
  assert.ok(summary.includes('verifiedSessions=246'));
  assert.ok(summary.includes('realCanonicalSessions=246'));
  assert.ok(summary.includes('authorizedDerivedSessions=0'));
  assert.ok(summary.includes('derivedProofRequired=false'));
  assert.ok(summary.includes('physicalStorageVerifiedSessionCount=246'));
  assert.ok(summary.includes('verifiedTargetPairs=738'));
  assert.equal(/march7/i.test(summary), false, 'a clean-year 2023 certification must never print a march7-shaped output line');
});

// ---- checksum handoff ----

test('B. missing canonicalManifestChecksum input -> FAILED, service never called', async () => {
  const service = new FakeCertificationService(fullyValidResult());
  const { success, errorLines } = await run(service, { canonical: undefined });
  assert.equal(success, false);
  assert.equal(service.certifyCallCount, 0);
  assert.ok(errorLines.join('\n').includes('code=MISSING_CANONICAL_MANIFEST_CHECKSUM'));
});

test('C. malformed sourceAssemblyChecksum input -> FAILED, service never called', async () => {
  const service = new FakeCertificationService(fullyValidResult());
  const { success, errorLines } = await run(service, { assembly: 'zzz' });
  assert.equal(success, false);
  assert.equal(service.certifyCallCount, 0);
  assert.ok(errorLines.join('\n').includes('code=MALFORMED_SOURCE_ASSEMBLY_CHECKSUM'));
});

test('D. missing resamplingManifestChecksum input -> FAILED, service never called', async () => {
  const service = new FakeCertificationService(fullyValidResult());
  const { success, errorLines } = await run(service, { resampling: undefined });
  assert.equal(success, false);
  assert.equal(service.certifyCallCount, 0);
  assert.ok(errorLines.join('\n').includes('code=MISSING_RESAMPLING_MANIFEST_CHECKSUM'));
});

// ---- checksum bindings ----

test('E. wrong canonical checksum in the result -> FAILED, no persist', async () => {
  const base = fullyValidResult();
  const service = new FakeCertificationService({ ...base, certification: { ...base.certification, canonicalManifest: { ...base.certification.canonicalManifest, datasetChecksum: '0'.repeat(64) } } });
  const { success, errorLines } = await run(service);
  assert.equal(success, false);
  assert.equal(service.persistCallCount, 0);
  assert.ok(errorLines.join('\n').includes('code=WRONG_CANONICAL_CHECKSUM'));
});

test('F. wrong B-M7.3 resampling manifest checksum in the result -> FAILED, no persist', async () => {
  const base = fullyValidResult();
  const service = new FakeCertificationService({ ...base, certification: { ...base.certification, resamplingManifestChecksum: '9'.repeat(64) } });
  const { success, errorLines } = await run(service);
  assert.equal(success, false);
  assert.ok(errorLines.join('\n').includes('code=WRONG_RESAMPLING_MANIFEST_CHECKSUM'));
});

// ---- session-count / topology postconditions ----

test('G. session count !== 246 -> FAILED, no persist', async () => {
  const base = fullyValidResult();
  const service = new FakeCertificationService({ ...base, certification: { ...base.certification, summary: { ...base.certification.summary, verifiedSessions: 200 } } });
  const { success, errorLines } = await run(service);
  assert.equal(success, false);
  assert.ok(errorLines.join('\n').includes('code=WRONG_SESSION_COUNT'));
});

test('H. unavailable sessions present -> FAILED, no persist', async () => {
  const base = fullyValidResult();
  const service = new FakeCertificationService({ ...base, certification: { ...base.certification, summary: { ...base.certification.summary, unavailableSessions: 1 } } });
  const { success, errorLines } = await run(service);
  assert.equal(success, false);
  assert.ok(errorLines.join('\n').includes('code=UNAVAILABLE_SESSIONS_PRESENT'));
});

test('I. an unexpected authorized-derived session appears -> FAILED, no persist', async () => {
  const base = fullyValidResult();
  const service = new FakeCertificationService({ ...base, certification: { ...base.certification, summary: { ...base.certification.summary, realCanonicalSessions: 245, authorizedDerivedSessions: 1 } } });
  const { success, errorLines } = await run(service);
  assert.equal(success, false);
  assert.ok(errorLines.join('\n').includes('code=UNEXPECTED_AUTHORIZED_DERIVED_SESSIONS'));
});

test('J. a non-null derivedSnapshotChecksum smuggled onto an otherwise-clean 0-derived result -> FAILED, no persist', async () => {
  const base = fullyValidResult();
  const service = new FakeCertificationService({ ...base, certification: { ...base.certification, derivedSnapshotChecksum: 'f'.repeat(64) } });
  const { success, errorLines } = await run(service);
  assert.equal(success, false);
  assert.ok(errorLines.join('\n').includes('code=UNEXPECTED_DERIVED_PROOF_FIELDS'));
});

test('K. a session with an unverified no-lookahead target fails -> FAILED, no persist', async () => {
  const genericDates = sequentialDates(245, '2020-01-01');
  const badSession: CertifiedSessionRecord = { ...genericSessionRecord('2021-12-31'), targets: [{ ...genericTargetRecord(ResampleTargetTimeframe.TWO_MINUTE), noLookaheadVerified: false }, genericTargetRecord(ResampleTargetTimeframe.THREE_MINUTE), genericTargetRecord(ResampleTargetTimeframe.FIVE_MINUTE)] };
  const base = fullyValidResult({ sessions: [...genericDates.map((d) => genericSessionRecord(d)), badSession] });
  const service = new FakeCertificationService(base);
  const { success, errorLines } = await run(service);
  assert.equal(success, false);
  assert.ok(errorLines.join('\n').includes('code=NO_LOOKAHEAD_NOT_VERIFIED'));
});

// ---- physical storage binding ----

test('L. physicalStorage.sessions.length !== 246 -> FAILED, no persist', async () => {
  const base = fullyValidResult();
  const service = new FakeCertificationService({ ...base, certification: { ...base.certification, physicalStorage: { ...base.certification.physicalStorage, sessions: base.certification.physicalStorage.sessions.slice(0, 100) } } });
  const { success, errorLines } = await run(service);
  assert.equal(success, false);
  assert.ok(errorLines.join('\n').includes('code=WRONG_PHYSICAL_STORAGE_SESSION_COUNT'));
});

// ---- aggregate totals ----

test('M. wrong 2m aggregate totals -> FAILED, no persist', async () => {
  const base = fullyValidResult();
  const service = new FakeCertificationService({ ...base, certification: { ...base.certification, summary: { ...base.certification.summary, byTarget: { ...base.certification.summary.byTarget, [ResampleTargetTimeframe.TWO_MINUTE]: { ...base.certification.summary.byTarget[ResampleTargetTimeframe.TWO_MINUTE], totalOutputCandles: 999 } } } } });
  const { success, errorLines } = await run(service);
  assert.equal(success, false);
  assert.ok(errorLines.join('\n').includes('code=WRONG_TARGET_AGGREGATE_TOTALS'));
});

// ---- exceptions ----

test('N. certifyYear throws -> FAILED, non-zero, no persist attempted', async () => {
  const service = new FakeCertificationService(new Error('canonical Parquet storage is UNMATERIALIZED'));
  const { success, lines, errorLines } = await run(service);
  assert.equal(success, false);
  assert.equal(lines.length, 0);
  assert.equal(service.persistCallCount, 0);
  assert.ok(errorLines.join('\n').includes('canonical Parquet storage is UNMATERIALIZED'));
});

test('O. persistCertification throws even though every postcondition passed -> FAILED, non-zero, no SUCCESS', async () => {
  const service = new FakeCertificationService(fullyValidResult(), new Error('disk full'));
  const { success, lines, errorLines } = await run(service);
  assert.equal(success, false);
  assert.equal(lines.length, 0);
  assert.equal(service.persistCallCount, 1);
  assert.ok(errorLines.join('\n').includes('code=PERSISTENCE_FAILED'));
  assert.ok(errorLines.join('\n').includes('disk full'));
});

// ---- structural ----

test('structural: this CLI reads exactly three environment variables (the year-specific checksum handoff) and never invents a placeholder checksum constant', () => {
  const source = readFileSync(join(__dirname, 'research-nifty-2023-certify.ts'), 'utf8');
  const envMatches = source.match(/process\.env\[/g) ?? [];
  assert.equal(envMatches.length, 3);
  assert.ok(source.includes('RESEARCH_NIFTY_2023_CANONICAL_MANIFEST_CHECKSUM'));
  assert.ok(source.includes('RESEARCH_NIFTY_2023_SOURCE_ASSEMBLY_CHECKSUM'));
  assert.ok(source.includes('RESEARCH_NIFTY_2023_RESAMPLING_MANIFEST_CHECKSUM'));
  assert.equal(/from\s+['"][^'"]*upstox[^'"]*['"]/i.test(source), false);
});

test('structural: this CLI never imports ResearchYearRunnerService (a doc-comment mention explaining it is out of scope is fine)', () => {
  const source = readFileSync(join(__dirname, 'research-nifty-2023-certify.ts'), 'utf8');
  assert.equal(/import[^;]*ResearchYearRunnerService/.test(source), false);
  assert.equal(/from\s+['"][^'"]*research-year-runner[^'"]*['"]/i.test(source), false);
});

test('structural: the CLI persists ONLY after postcondition validation -- in source order', () => {
  const source = readFileSync(join(__dirname, 'research-nifty-2023-certify.ts'), 'utf8');
  const validateIndex = source.indexOf('validateLockedPostconditions(result, checksumInputs)');
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
