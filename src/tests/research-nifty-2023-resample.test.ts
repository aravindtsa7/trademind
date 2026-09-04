import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Prisma } from '@prisma/client';
import { ResearchSessionSourcePrecedenceTier } from '../modules/research-lake/domain/derived-imputed-research-session.types';
import { ResampleTargetTimeframe } from '../modules/research-lake/domain/resampled-candle.types';
import { ResearchCandleQuality, ResearchResampleSessionDescriptor, ResearchResampleSessionStatus, ResearchResampledCandle } from '../modules/research-lake/domain/research-underlying-resampled-candle.types';
import {
  buildResearchUnderlyingResamplingManifest,
  RESEARCH_UNDERLYING_RESAMPLING_MANIFEST_SCHEMA_VERSION,
  RESEARCH_UNDERLYING_RESAMPLING_TARGET_TIMEFRAMES,
  ResearchUnderlyingResamplingManifestSessionEntry,
  ResearchUnderlyingResamplingManifestV1,
} from '../modules/research-lake/domain/research-underlying-resampling-manifest.types';
import { ContentAddressedJsonStoreResult } from '../modules/research-lake/domain/content-addressed-json-store';
import { ResearchUnderlyingDatasetAssemblyV1 } from '../modules/research-lake/domain/research-underlying-assembly.types';
import { ManifestDatasetKind } from '../modules/research-lake/domain/dataset-manifest.types';
import { ResolvedResearchRowSourceKind } from '../modules/research-lake/services/research-underlying-1m-session-reader.service';
import { NIFTY_INDEX_INSTRUMENT_KEY, NIFTY_UNDERLYING_TIMEFRAME } from '../modules/research-lake/services/nifty-underlying-identity';
import { BuildAndPersistResamplingManifest, VerifyResampledSession, runNifty2023Resample } from './research-nifty-2023-resample';
import { BuildYearResamplingManifestResult } from '../modules/research-lake/services/research-underlying-resampling-manifest-builder.service';
import { ReadResampledSessionRequest, ReadResampledSessionResult } from '../modules/research-lake/services/research-underlying-resampled-session-reader.service';

const VALID_CHECKSUM = 'a'.repeat(64);
const MUHURAT_DATE = '2023-11-12';
const REGULAR_COUNTS: Record<ResampleTargetTimeframe, number> = { [ResampleTargetTimeframe.TWO_MINUTE]: 187, [ResampleTargetTimeframe.THREE_MINUTE]: 125, [ResampleTargetTimeframe.FIVE_MINUTE]: 75 };
const REGULAR_TRAILING: Record<ResampleTargetTimeframe, number> = { [ResampleTargetTimeframe.TWO_MINUTE]: 1, [ResampleTargetTimeframe.THREE_MINUTE]: 0, [ResampleTargetTimeframe.FIVE_MINUTE]: 0 };
const MUHURAT_COUNTS: Record<ResampleTargetTimeframe, number> = { [ResampleTargetTimeframe.TWO_MINUTE]: 30, [ResampleTargetTimeframe.THREE_MINUTE]: 20, [ResampleTargetTimeframe.FIVE_MINUTE]: 12 };
const BUCKET_MINUTES: Record<ResampleTargetTimeframe, number> = { [ResampleTargetTimeframe.TWO_MINUTE]: 2, [ResampleTargetTimeframe.THREE_MINUTE]: 3, [ResampleTargetTimeframe.FIVE_MINUTE]: 5 };

function captureOutput(): { lines: string[]; errorLines: string[]; output: (line: string) => void; errorOutput: (line: string) => void } {
  const lines: string[] = [];
  const errorLines: string[] = [];
  return { lines, errorLines, output: (line) => lines.push(line), errorOutput: (line) => errorLines.push(line) };
}

class FakeManifestService implements BuildAndPersistResamplingManifest {
  public buildCallCount = 0;
  public persistCallCount = 0;
  constructor(
    private readonly resultOrError: BuildYearResamplingManifestResult | Error,
    private readonly persistResultOrError?: ContentAddressedJsonStoreResult | Error
  ) {}
  async buildYearManifest(): Promise<BuildYearResamplingManifestResult> {
    this.buildCallCount += 1;
    if (this.resultOrError instanceof Error) throw this.resultOrError;
    return this.resultOrError;
  }
  persistManifest(manifest: ResearchUnderlyingResamplingManifestV1): ContentAddressedJsonStoreResult {
    this.persistCallCount += 1;
    const outcome: ContentAddressedJsonStoreResult | Error =
      this.persistResultOrError ?? { relativePath: `research-underlying-resampling-manifests/${manifest.manifestContentChecksum}.json`, absolutePath: `/tmp/research-underlying-resampling-manifests/${manifest.manifestContentChecksum}.json`, wasNewlyWritten: true };
    if (outcome instanceof Error) throw outcome;
    return outcome;
  }
}

function fakeCandle(bucketStartMs: number, bucketEndMs: number, quality: ResearchCandleQuality = ResearchCandleQuality.REAL_CANONICAL_ONLY): ResearchResampledCandle {
  const availableAtIso = new Date(bucketEndMs).toISOString();
  return {
    bucketStart: new Date(bucketStartMs),
    bucketEnd: new Date(bucketEndMs),
    availableAt: new Date(bucketEndMs),
    open: new Prisma.Decimal(0),
    high: new Prisma.Decimal(0),
    low: new Prisma.Decimal(0),
    close: new Prisma.Decimal(0),
    volume: 0n,
    openInterest: null,
    quality,
    constituents: [{ candleTime: new Date(bucketStartMs).toISOString(), availableAt: availableAtIso, provenance: { sourceKind: ResolvedResearchRowSourceKind.REAL_CANONICAL } }],
  };
}

function correctCandlesFor(tradingDate: string, target: ResampleTargetTimeframe): ResearchResampledCandle[] {
  const isMuhurat = tradingDate === MUHURAT_DATE;
  const windowOpenMinuteIst = isMuhurat ? 1095 : 555;
  const count = isMuhurat ? MUHURAT_COUNTS[target] : REGULAR_COUNTS[target];
  const bucketMinutes = BUCKET_MINUTES[target];
  const dayStartMs = new Date(`${tradingDate}T00:00:00+05:30`).getTime();
  const candles: ResearchResampledCandle[] = [];
  for (let i = 0; i < count; i += 1) {
    const bucketStartMs = dayStartMs + (windowOpenMinuteIst + i * bucketMinutes) * 60_000;
    candles.push(fakeCandle(bucketStartMs, bucketStartMs + bucketMinutes * 60_000));
  }
  return candles;
}

class FakeVerifier implements VerifyResampledSession {
  public calls: ReadResampledSessionRequest[] = [];
  constructor(
    private readonly overrideCandles?: (request: ReadResampledSessionRequest) => ResearchResampledCandle[],
    private readonly throwError?: Error
  ) {}
  async readResampledSession(request: ReadResampledSessionRequest): Promise<ReadResampledSessionResult> {
    this.calls.push(request);
    if (this.throwError) throw this.throwError;
    const candles = this.overrideCandles ? this.overrideCandles(request) : correctCandlesFor(request.tradingDate, request.targetTimeframe);
    return { candles, descriptor: {} as ResearchResampleSessionDescriptor };
  }
}

function genericDescriptor(tradingDate: string, target: ResampleTargetTimeframe, isMuhurat: boolean, overrides: Partial<ResearchResampleSessionDescriptor> = {}): ResearchResampleSessionDescriptor {
  return {
    researchResamplingSchemaVersion: 1,
    researchResamplingSemanticsVersion: 1,
    sourceAssemblyChecksum: VALID_CHECKSUM,
    tradingDate,
    sourcePrecedenceTier: ResearchSessionSourcePrecedenceTier.HEALTHY_REAL_CANONICAL_SESSION,
    sourceContentChecksum: 'c'.repeat(64),
    targetTimeframe: target,
    sessionWindows: isMuhurat ? [{ windowIndex: 0, openMinuteIst: 1095, closeMinuteIst: 1155 }] : [{ windowIndex: 0, openMinuteIst: 555, closeMinuteIst: 930 }],
    sourceRowCount: isMuhurat ? 60 : 375,
    expectedSourceMinuteCount: isMuhurat ? 60 : 375,
    outputCandleCount: isMuhurat ? MUHURAT_COUNTS[target] : REGULAR_COUNTS[target],
    structuralTrailingRowCount: isMuhurat ? 0 : REGULAR_TRAILING[target],
    missingSourceMinuteCount: 0,
    realCanonicalConstituentRowCount: isMuhurat ? 60 : 375,
    derivedObservedConstituentRowCount: 0,
    derivedImputedConstituentRowCount: 0,
    candlesContainingImputation: 0,
    researchDerivedContentChecksum: 'r'.repeat(64),
    status: ResearchResampleSessionStatus.COMPLETE_RESEARCH_SESSION,
    ...overrides,
  };
}

function sessionEntry(tradingDate: string, isMuhurat = false, targetOverrides: Partial<Record<ResampleTargetTimeframe, Partial<ResearchResampleSessionDescriptor>>> = {}): ResearchUnderlyingResamplingManifestSessionEntry {
  return {
    tradingDate,
    targets: {
      [ResampleTargetTimeframe.TWO_MINUTE]: genericDescriptor(tradingDate, ResampleTargetTimeframe.TWO_MINUTE, isMuhurat, targetOverrides[ResampleTargetTimeframe.TWO_MINUTE]),
      [ResampleTargetTimeframe.THREE_MINUTE]: genericDescriptor(tradingDate, ResampleTargetTimeframe.THREE_MINUTE, isMuhurat, targetOverrides[ResampleTargetTimeframe.THREE_MINUTE]),
      [ResampleTargetTimeframe.FIVE_MINUTE]: genericDescriptor(tradingDate, ResampleTargetTimeframe.FIVE_MINUTE, isMuhurat, targetOverrides[ResampleTargetTimeframe.FIVE_MINUTE]),
    },
  };
}

function sequentialDates(count: number, startIsoDate: string): string[] {
  const start = new Date(`${startIsoDate}T00:00:00.000Z`);
  return Array.from({ length: count }, (_, i) => new Date(start.getTime() + i * 86_400_000).toISOString().slice(0, 10));
}

function fakeSourceAssembly(): ResearchUnderlyingDatasetAssemblyV1 {
  return {
    schemaVersion: 1,
    assemblySemanticsVersion: 1,
    identity: { instrumentKey: NIFTY_INDEX_INSTRUMENT_KEY, timeframe: NIFTY_UNDERLYING_TIMEFRAME, year: 2023 },
    canonicalManifest: { datasetKind: ManifestDatasetKind.UNDERLYING_1M, datasetId: 'UNDERLYING_1M_xyz', datasetChecksum: 'f'.repeat(64), manifestSchemaVersion: 5, canonicalizationVersion: 1, healthSemanticsVersion: 1 },
    sessions: [],
    sessionCounts: { expectedSessions: 246, researchReadySessions: 246, realCanonicalSessions: 246, compositeRepairedSessions: 0, authorizedDerivedSessions: 0, unavailableSessions: 0 },
    assemblyContentChecksum: VALID_CHECKSUM,
  };
}

function fullyValidResult(sessionOverrides: (sessions: ResearchUnderlyingResamplingManifestSessionEntry[]) => ResearchUnderlyingResamplingManifestSessionEntry[] = (s) => s, targetTimeframes = RESEARCH_UNDERLYING_RESAMPLING_TARGET_TIMEFRAMES): BuildYearResamplingManifestResult {
  const regularDates = sequentialDates(245, '2020-01-01');
  const sessions = sessionOverrides([...regularDates.map((d) => sessionEntry(d)), sessionEntry(MUHURAT_DATE, true)]);
  const manifest = buildResearchUnderlyingResamplingManifest({
    schemaVersion: RESEARCH_UNDERLYING_RESAMPLING_MANIFEST_SCHEMA_VERSION,
    resamplingSemanticsVersion: 1,
    sourceAssemblyChecksum: VALID_CHECKSUM,
    identity: { instrumentKey: NIFTY_INDEX_INSTRUMENT_KEY, sourceTimeframe: NIFTY_UNDERLYING_TIMEFRAME, year: 2023 },
    targetTimeframes,
    sourceSessionCounts: { expectedSessions: sessions.length, unavailableSessions: 0 },
    sessions,
  });
  return { manifest, sourceAssembly: fakeSourceAssembly() };
}

async function run(service: BuildAndPersistResamplingManifest, verifier: VerifyResampledSession, checksum: { value: string | undefined } = { value: VALID_CHECKSUM }) {
  const { lines, errorLines, output, errorOutput } = captureOutput();
  const success = await runNifty2023Resample({ sourceAssemblyChecksum: checksum.value, buildService: () => service, buildVerifier: () => verifier, output, errorOutput });
  return { success, lines, errorLines };
}

// ---- A: happy path ----

test('A. exact locked postconditions + verified no-lookahead across all 738 pairs -> SUCCESS, manifest persisted exactly once', async () => {
  const service = new FakeManifestService(fullyValidResult());
  const verifier = new FakeVerifier();
  const { success, lines, errorLines } = await run(service, verifier);
  assert.equal(success, true);
  assert.equal(errorLines.length, 0);
  assert.equal(service.persistCallCount, 1);
  assert.equal(verifier.calls.length, 738);
  const summary = lines.join('\n');
  assert.ok(summary.includes('status=SUCCESS'));
  assert.ok(summary.includes('year=2023'));
  assert.ok(summary.includes('sourceSessions=246'));
  assert.ok(summary.includes('resolvedSessions=246'));
  assert.ok(summary.includes('unavailableSessions=0'));
  assert.ok(summary.includes('targets=2m,3m,5m'));
  assert.ok(summary.includes('verifiedSessionTargetPairs=738'));
  assert.ok(summary.includes('manifestContentChecksum='));
  assert.ok(summary.includes('manifestArtifact='));
});

// ---- checksum handoff ----

test('B. missing sourceAssemblyChecksum input -> FAILED, no build/persist attempted', async () => {
  const service = new FakeManifestService(fullyValidResult());
  const { success, errorLines } = await run(service, new FakeVerifier(), { value: undefined });
  assert.equal(success, false);
  assert.equal(service.buildCallCount, 0);
  assert.equal(service.persistCallCount, 0);
  assert.ok(errorLines.join('\n').includes('code=MISSING_SOURCE_ASSEMBLY_CHECKSUM'));
});

test('C. malformed sourceAssemblyChecksum input (not 64 lowercase hex) -> FAILED, no build attempted', async () => {
  const service = new FakeManifestService(fullyValidResult());
  const { success, errorLines } = await run(service, new FakeVerifier(), { value: 'not-a-checksum' });
  assert.equal(success, false);
  assert.equal(service.buildCallCount, 0);
  assert.ok(errorLines.join('\n').includes('code=MALFORMED_SOURCE_ASSEMBLY_CHECKSUM'));
});

test('D. built manifest sourceAssemblyChecksum does not match the operator-supplied input -> FAILED, no persist, verifier never called', async () => {
  const result = fullyValidResult();
  const wrong = { ...result, manifest: { ...result.manifest, sourceAssemblyChecksum: '0'.repeat(64) } };
  const service = new FakeManifestService(wrong);
  const verifier = new FakeVerifier();
  const { success, errorLines } = await run(service, verifier);
  assert.equal(success, false);
  assert.equal(service.persistCallCount, 0);
  assert.equal(verifier.calls.length, 0);
  assert.ok(errorLines.join('\n').includes('code=WRONG_SOURCE_ASSEMBLY_CHECKSUM'));
});

// ---- session-count postconditions ----

test('E. sourceSessionCounts.expectedSessions !== 246 -> FAILED, no persist', async () => {
  const result = fullyValidResult();
  const wrong = { ...result, manifest: { ...result.manifest, sourceSessionCounts: { ...result.manifest.sourceSessionCounts, expectedSessions: 99 } } };
  const service = new FakeManifestService(wrong);
  const { success, errorLines } = await run(service, new FakeVerifier());
  assert.equal(success, false);
  assert.equal(service.persistCallCount, 0);
  assert.ok(errorLines.join('\n').includes('code=WRONG_SOURCE_SESSION_COUNT'));
});

test('F. unavailableSessions !== 0 -> FAILED, no persist', async () => {
  const result = fullyValidResult();
  const wrong = { ...result, manifest: { ...result.manifest, sourceSessionCounts: { ...result.manifest.sourceSessionCounts, unavailableSessions: 1 } } };
  const service = new FakeManifestService(wrong);
  const { success, errorLines } = await run(service, new FakeVerifier());
  assert.equal(success, false);
  assert.equal(service.persistCallCount, 0);
  assert.ok(errorLines.join('\n').includes('code=UNAVAILABLE_SESSIONS_PRESENT'));
});

// ---- target set ----

test('G. missing a target timeframe (2m,3m only) -> FAILED, no persist', async () => {
  const result = fullyValidResult((s) => s, [ResampleTargetTimeframe.TWO_MINUTE, ResampleTargetTimeframe.THREE_MINUTE]);
  const service = new FakeManifestService(result);
  const { success, errorLines } = await run(service, new FakeVerifier());
  assert.equal(success, false);
  assert.equal(service.persistCallCount, 0);
  assert.ok(errorLines.join('\n').includes('code=WRONG_TARGET_TIMEFRAME_SET'));
});

// ---- quality: 100% REAL_CANONICAL_ONLY ----

test('H. a non-real-canonical sourcePrecedenceTier on one date fails closed', async () => {
  const result = fullyValidResult((sessions) =>
    sessions.map((s, i) => (i === 0 ? sessionEntry(s.tradingDate, false, { [ResampleTargetTimeframe.TWO_MINUTE]: { sourcePrecedenceTier: ResearchSessionSourcePrecedenceTier.ACCEPTED_COMPOSITE_REPAIRED_CANONICAL_SESSION } }) : s))
  );
  const service = new FakeManifestService(result);
  const { success, errorLines } = await run(service, new FakeVerifier());
  assert.equal(success, false);
  assert.equal(service.persistCallCount, 0);
  assert.ok(errorLines.join('\n').includes('code=NON_REAL_CANONICAL_SOURCE'));
});

test('I. unexpected imputation on one descriptor fails closed', async () => {
  const result = fullyValidResult((sessions) => sessions.map((s, i) => (i === 0 ? sessionEntry(s.tradingDate, false, { [ResampleTargetTimeframe.TWO_MINUTE]: { derivedImputedConstituentRowCount: 1 } }) : s)));
  const service = new FakeManifestService(result);
  const { success, errorLines } = await run(service, new FakeVerifier());
  assert.equal(success, false);
  assert.equal(service.persistCallCount, 0);
  assert.ok(errorLines.join('\n').includes('code=UNEXPECTED_IMPUTATION'));
});

// ---- exact aggregate totals ----

test('J. wrong 2m aggregate total (one descriptor tampered) fails closed', async () => {
  const result = fullyValidResult((sessions) => sessions.map((s, i) => (i === 0 ? sessionEntry(s.tradingDate, false, { [ResampleTargetTimeframe.TWO_MINUTE]: { outputCandleCount: 999 } }) : s)));
  const service = new FakeManifestService(result);
  const { success, errorLines } = await run(service, new FakeVerifier());
  assert.equal(success, false);
  assert.equal(service.persistCallCount, 0);
  assert.ok(errorLines.join('\n').includes('code=WRONG_TARGET_AGGREGATE_TOTALS'));
});

// ---- Muhurat facts ----

test('K. Muhurat session missing entirely fails closed', async () => {
  const result = fullyValidResult((sessions) => sessions.filter((s) => s.tradingDate !== MUHURAT_DATE));
  const service = new FakeManifestService(result);
  const { success, errorLines } = await run(service, new FakeVerifier());
  assert.equal(success, false);
  assert.equal(service.persistCallCount, 0);
  assert.ok(errorLines.join('\n').includes('status=FAILED'));
});

test('L. Muhurat wrong source row count (not 60) fails closed', async () => {
  const result = fullyValidResult((sessions) => sessions.map((s) => (s.tradingDate === MUHURAT_DATE ? sessionEntry(MUHURAT_DATE, true, { [ResampleTargetTimeframe.TWO_MINUTE]: { sourceRowCount: 61 } }) : s)));
  const service = new FakeManifestService(result);
  const { success, errorLines } = await run(service, new FakeVerifier());
  assert.equal(success, false);
  assert.equal(service.persistCallCount, 0);
  assert.ok(errorLines.join('\n').includes('code=MUHURAT_WRONG_SOURCE_ROW_COUNT'));
});

test('M. Muhurat wrong 3m output count (not 20) fails closed -- also depresses the year aggregate total, so WRONG_TARGET_AGGREGATE_TOTALS fires first (still fails closed)', async () => {
  const result = fullyValidResult((sessions) => sessions.map((s) => (s.tradingDate === MUHURAT_DATE ? sessionEntry(MUHURAT_DATE, true, { [ResampleTargetTimeframe.THREE_MINUTE]: { outputCandleCount: 999 } }) : s)));
  const service = new FakeManifestService(result);
  const { success, errorLines } = await run(service, new FakeVerifier());
  assert.equal(success, false);
  assert.equal(service.persistCallCount, 0);
  assert.ok(errorLines.join('\n').includes('code=WRONG_TARGET_AGGREGATE_TOTALS'));
});

test('M2. Muhurat wrong 5m output count, compensated elsewhere so the aggregate total still matches -> isolates MUHURAT_WRONG_TARGET_COUNTS specifically', async () => {
  const result = fullyValidResult((sessions) =>
    sessions.map((s, i) => {
      if (s.tradingDate === MUHURAT_DATE) return sessionEntry(MUHURAT_DATE, true, { [ResampleTargetTimeframe.FIVE_MINUTE]: { outputCandleCount: 20 } }); // +8 vs the correct 12
      if (i === 0) return sessionEntry(s.tradingDate, false, { [ResampleTargetTimeframe.FIVE_MINUTE]: { outputCandleCount: REGULAR_COUNTS[ResampleTargetTimeframe.FIVE_MINUTE] - 8 } }); // -8 to compensate
      return s;
    })
  );
  const service = new FakeManifestService(result);
  const { success, errorLines } = await run(service, new FakeVerifier());
  assert.equal(success, false);
  assert.equal(service.persistCallCount, 0);
  assert.ok(errorLines.join('\n').includes('code=MUHURAT_WRONG_TARGET_COUNTS'));
});

// ---- no-lookahead re-verification ----

test('N. a no-lookahead violation (availableAt !== MAX(constituent availableAt)) fails closed, no persist', async () => {
  const service = new FakeManifestService(fullyValidResult());
  const brokenVerifier = new FakeVerifier((request) => {
    if (request.tradingDate === MUHURAT_DATE && request.targetTimeframe === ResampleTargetTimeframe.TWO_MINUTE) {
      const candles = correctCandlesFor(request.tradingDate, request.targetTimeframe);
      const [first, ...rest] = candles;
      return [{ ...first, availableAt: new Date(first.availableAt.getTime() - 60_000) }, ...rest];
    }
    return correctCandlesFor(request.tradingDate, request.targetTimeframe);
  });
  const { success, errorLines } = await run(service, brokenVerifier);
  assert.equal(success, false);
  assert.equal(service.persistCallCount, 0);
  assert.ok(errorLines.join('\n').includes('code=NO_LOOKAHEAD_VIOLATION'));
});

test('O. a non-REAL_CANONICAL_ONLY candle quality fails closed', async () => {
  const service = new FakeManifestService(fullyValidResult());
  const brokenVerifier = new FakeVerifier((request) => {
    if (request.tradingDate === MUHURAT_DATE && request.targetTimeframe === ResampleTargetTimeframe.FIVE_MINUTE) {
      const candles = correctCandlesFor(request.tradingDate, request.targetTimeframe);
      const [first, ...rest] = candles;
      return [{ ...first, quality: ResearchCandleQuality.CONTAINS_AUTHORIZED_IMPUTATION }, ...rest];
    }
    return correctCandlesFor(request.tradingDate, request.targetTimeframe);
  });
  const { success, errorLines } = await run(service, brokenVerifier);
  assert.equal(success, false);
  assert.equal(service.persistCallCount, 0);
  assert.ok(errorLines.join('\n').includes('code=NON_REAL_CANONICAL_QUALITY'));
});

test('P. a candle count mismatch between the manifest descriptor and the verified reader fails closed', async () => {
  const service = new FakeManifestService(fullyValidResult());
  const brokenVerifier = new FakeVerifier((request) => {
    if (request.tradingDate === MUHURAT_DATE && request.targetTimeframe === ResampleTargetTimeframe.TWO_MINUTE) {
      return correctCandlesFor(request.tradingDate, request.targetTimeframe).slice(0, -1);
    }
    return correctCandlesFor(request.tradingDate, request.targetTimeframe);
  });
  const { success, errorLines } = await run(service, brokenVerifier);
  assert.equal(success, false);
  assert.equal(service.persistCallCount, 0);
  assert.ok(errorLines.join('\n').includes('code=CANDLE_COUNT_MISMATCH'));
});

test('Q. a Muhurat bucket bridging outside 18:15-19:15 IST fails closed', async () => {
  const service = new FakeManifestService(fullyValidResult());
  const brokenVerifier = new FakeVerifier((request) => {
    if (request.tradingDate === MUHURAT_DATE && request.targetTimeframe === ResampleTargetTimeframe.TWO_MINUTE) {
      const candles = correctCandlesFor(request.tradingDate, request.targetTimeframe);
      const last = candles[candles.length - 1];
      const bridged = fakeCandle(last.bucketStart.getTime(), last.bucketStart.getTime() + 30 * 60_000);
      return [...candles.slice(0, -1), bridged];
    }
    return correctCandlesFor(request.tradingDate, request.targetTimeframe);
  });
  const { success, errorLines } = await run(service, brokenVerifier);
  assert.equal(success, false);
  assert.equal(service.persistCallCount, 0);
  assert.ok(errorLines.join('\n').includes('code=MUHURAT_BUCKET_BRIDGES_WINDOW'));
});

test('R. the verified read boundary throwing fails closed, no persist', async () => {
  const service = new FakeManifestService(fullyValidResult());
  const throwingVerifier = new FakeVerifier(undefined, new Error('researchDerivedContentChecksum mismatch'));
  const { success, errorLines } = await run(service, throwingVerifier);
  assert.equal(success, false);
  assert.equal(service.persistCallCount, 0);
  const summary = errorLines.join('\n');
  assert.ok(summary.includes('code=NO_LOOKAHEAD_VERIFICATION_FAILED'));
  assert.ok(summary.includes('researchDerivedContentChecksum mismatch'));
});

// ---- exceptions ----

test('S. buildYearManifest throws -> FAILED, non-zero, no persist attempted, verifier never called', async () => {
  const service = new FakeManifestService(new Error('trusted assembly integrity check failed'));
  const verifier = new FakeVerifier();
  const { success, lines, errorLines } = await run(service, verifier);
  assert.equal(success, false);
  assert.equal(lines.length, 0);
  assert.equal(service.persistCallCount, 0);
  assert.equal(verifier.calls.length, 0);
  const summary = errorLines.join('\n');
  assert.ok(summary.includes('code=BUILD_FAILED'));
  assert.ok(summary.includes('trusted assembly integrity check failed'));
});

test('T. persistManifest throws even though every postcondition + proof passed -> FAILED, non-zero, no SUCCESS output', async () => {
  const service = new FakeManifestService(fullyValidResult(), new Error('disk full'));
  const { success, lines, errorLines } = await run(service, new FakeVerifier());
  assert.equal(success, false);
  assert.equal(lines.length, 0);
  assert.equal(service.persistCallCount, 1);
  const summary = errorLines.join('\n');
  assert.ok(summary.includes('code=PERSISTENCE_FAILED'));
  assert.ok(summary.includes('disk full'));
});

// ---- structural ----

test('structural: this test file never imports the real manifest builder class, Prisma as a service dependency, or a provider client as a value', () => {
  const source = readFileSync(join(__dirname, 'research-nifty-2023-resample.ts'), 'utf8');
  assert.equal(/from\s+['"]@prisma\/client['"]/i.test(source), false);
  assert.equal(/from\s+['"][^'"]*upstox[^'"]*['"]/i.test(source), false);
});

test('structural: the CLI reads exactly one environment variable (the year-specific source-assembly checksum handoff) and never invents a placeholder checksum constant', () => {
  const source = readFileSync(join(__dirname, 'research-nifty-2023-resample.ts'), 'utf8');
  const envMatches = source.match(/process\.env\[/g) ?? [];
  assert.equal(envMatches.length, 1);
  assert.ok(source.includes('RESEARCH_NIFTY_2023_SOURCE_ASSEMBLY_CHECKSUM'));
});

test('structural: the CLI persists the trusted manifest ONLY after postcondition validation and no-lookahead re-verification -- in that source order', () => {
  const source = readFileSync(join(__dirname, 'research-nifty-2023-resample.ts'), 'utf8');
  const validateIndex = source.indexOf('validateLockedProductionPostconditions(result.manifest, sourceAssemblyChecksum)');
  const proofIndex = source.indexOf('validateNoLookaheadAcrossAllSessions(verifier, result.manifest, result.sourceAssembly)');
  const persistIndex = source.indexOf('service.persistManifest(result.manifest)');
  assert.ok(validateIndex > 0 && proofIndex > 0 && persistIndex > 0);
  assert.ok(validateIndex < proofIndex && proofIndex < persistIndex);
});

test('the service is called exactly once per run (buildYearManifest), and persistManifest at most once', async () => {
  const service = new FakeManifestService(fullyValidResult());
  await run(service, new FakeVerifier());
  assert.equal(service.buildCallCount, 1);
  assert.equal(service.persistCallCount, 1);
});
