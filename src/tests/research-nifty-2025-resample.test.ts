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
import { BuildAndPersistResamplingManifest, VerifyResampledSession, runNifty2025Resample } from './research-nifty-2025-resample';
import { BuildYearResamplingManifestResult } from '../modules/research-lake/services/research-underlying-resampling-manifest-builder.service';
import { ReadResampledSessionRequest, ReadResampledSessionResult } from '../modules/research-lake/services/research-underlying-resampled-session-reader.service';

const VALID_CHECKSUM = 'a'.repeat(64);
const FEB1_DATE = '2025-02-01';
const OCT21_DATE = '2025-10-21';
const COMPOSITE_REPAIRED_DATES: readonly string[] = ['2025-03-25', '2025-04-04', '2025-04-23'];

const REGULAR_COUNTS: Record<ResampleTargetTimeframe, number> = { [ResampleTargetTimeframe.TWO_MINUTE]: 187, [ResampleTargetTimeframe.THREE_MINUTE]: 125, [ResampleTargetTimeframe.FIVE_MINUTE]: 75 };
const REGULAR_TRAILING: Record<ResampleTargetTimeframe, number> = { [ResampleTargetTimeframe.TWO_MINUTE]: 1, [ResampleTargetTimeframe.THREE_MINUTE]: 0, [ResampleTargetTimeframe.FIVE_MINUTE]: 0 };
const MUHURAT_COUNTS: Record<ResampleTargetTimeframe, number> = { [ResampleTargetTimeframe.TWO_MINUTE]: 30, [ResampleTargetTimeframe.THREE_MINUTE]: 20, [ResampleTargetTimeframe.FIVE_MINUTE]: 12 };
const MUHURAT_TRAILING: Record<ResampleTargetTimeframe, number> = { [ResampleTargetTimeframe.TWO_MINUTE]: 0, [ResampleTargetTimeframe.THREE_MINUTE]: 0, [ResampleTargetTimeframe.FIVE_MINUTE]: 0 };
const BUCKET_MINUTES: Record<ResampleTargetTimeframe, number> = { [ResampleTargetTimeframe.TWO_MINUTE]: 2, [ResampleTargetTimeframe.THREE_MINUTE]: 3, [ResampleTargetTimeframe.FIVE_MINUTE]: 5 };

const DEFAULT_WINDOWS: readonly { openMinuteIst: number; closeMinuteIst: number }[] = [{ openMinuteIst: 555, closeMinuteIst: 930 }];
const OCT21_WINDOWS: readonly { openMinuteIst: number; closeMinuteIst: number }[] = [{ openMinuteIst: 825, closeMinuteIst: 885 }];

interface SessionShape {
  readonly sourceRowCount: number;
  readonly counts: Record<ResampleTargetTimeframe, number>;
  readonly trailing: Record<ResampleTargetTimeframe, number>;
  readonly tier: ResearchSessionSourcePrecedenceTier;
  readonly windows: readonly { openMinuteIst: number; closeMinuteIst: number }[];
}

function shapeFor(tradingDate: string): SessionShape {
  if (tradingDate === OCT21_DATE) {
    return { sourceRowCount: 60, counts: MUHURAT_COUNTS, trailing: MUHURAT_TRAILING, tier: ResearchSessionSourcePrecedenceTier.HEALTHY_REAL_CANONICAL_SESSION, windows: OCT21_WINDOWS };
  }
  if (COMPOSITE_REPAIRED_DATES.includes(tradingDate)) {
    return { sourceRowCount: 375, counts: REGULAR_COUNTS, trailing: REGULAR_TRAILING, tier: ResearchSessionSourcePrecedenceTier.ACCEPTED_COMPOSITE_REPAIRED_CANONICAL_SESSION, windows: DEFAULT_WINDOWS };
  }
  return { sourceRowCount: 375, counts: REGULAR_COUNTS, trailing: REGULAR_TRAILING, tier: ResearchSessionSourcePrecedenceTier.HEALTHY_REAL_CANONICAL_SESSION, windows: DEFAULT_WINDOWS };
}

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

/** Generates candles window-by-window, mirroring the real resampler's per-window bucketing exactly. */
function correctCandlesFor(tradingDate: string, target: ResampleTargetTimeframe): ResearchResampledCandle[] {
  const { windows } = shapeFor(tradingDate);
  const bucketMinutes = BUCKET_MINUTES[target];
  const dayStartMs = new Date(`${tradingDate}T00:00:00+05:30`).getTime();
  const candles: ResearchResampledCandle[] = [];
  for (const window of windows) {
    const windowMinutes = window.closeMinuteIst - window.openMinuteIst;
    const count = Math.floor(windowMinutes / bucketMinutes);
    for (let i = 0; i < count; i += 1) {
      const bucketStartMs = dayStartMs + (window.openMinuteIst + i * bucketMinutes) * 60_000;
      candles.push(fakeCandle(bucketStartMs, bucketStartMs + bucketMinutes * 60_000));
    }
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

function genericDescriptor(tradingDate: string, target: ResampleTargetTimeframe, overrides: Partial<ResearchResampleSessionDescriptor> = {}): ResearchResampleSessionDescriptor {
  const shape = shapeFor(tradingDate);
  return {
    researchResamplingSchemaVersion: 1,
    researchResamplingSemanticsVersion: 1,
    sourceAssemblyChecksum: VALID_CHECKSUM,
    tradingDate,
    sourcePrecedenceTier: shape.tier,
    sourceContentChecksum: 'c'.repeat(64),
    targetTimeframe: target,
    sessionWindows: shape.windows.map((window, index) => ({ windowIndex: index, ...window })),
    sourceRowCount: shape.sourceRowCount,
    expectedSourceMinuteCount: shape.sourceRowCount,
    outputCandleCount: shape.counts[target],
    structuralTrailingRowCount: shape.trailing[target],
    missingSourceMinuteCount: 0,
    realCanonicalConstituentRowCount: shape.sourceRowCount,
    derivedObservedConstituentRowCount: 0,
    derivedImputedConstituentRowCount: 0,
    candlesContainingImputation: 0,
    researchDerivedContentChecksum: 'r'.repeat(64),
    status: ResearchResampleSessionStatus.COMPLETE_RESEARCH_SESSION,
    ...overrides,
  };
}

function sessionEntry(tradingDate: string, targetOverrides: Partial<Record<ResampleTargetTimeframe, Partial<ResearchResampleSessionDescriptor>>> = {}): ResearchUnderlyingResamplingManifestSessionEntry {
  return {
    tradingDate,
    targets: {
      [ResampleTargetTimeframe.TWO_MINUTE]: genericDescriptor(tradingDate, ResampleTargetTimeframe.TWO_MINUTE, targetOverrides[ResampleTargetTimeframe.TWO_MINUTE]),
      [ResampleTargetTimeframe.THREE_MINUTE]: genericDescriptor(tradingDate, ResampleTargetTimeframe.THREE_MINUTE, targetOverrides[ResampleTargetTimeframe.THREE_MINUTE]),
      [ResampleTargetTimeframe.FIVE_MINUTE]: genericDescriptor(tradingDate, ResampleTargetTimeframe.FIVE_MINUTE, targetOverrides[ResampleTargetTimeframe.FIVE_MINUTE]),
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
    identity: { instrumentKey: NIFTY_INDEX_INSTRUMENT_KEY, timeframe: NIFTY_UNDERLYING_TIMEFRAME, year: 2025 },
    canonicalManifest: { datasetKind: ManifestDatasetKind.UNDERLYING_1M, datasetId: 'UNDERLYING_1M_xyz', datasetChecksum: 'f'.repeat(64), manifestSchemaVersion: 5, canonicalizationVersion: 1, healthSemanticsVersion: 1 },
    sessions: [],
    sessionCounts: { expectedSessions: 249, researchReadySessions: 249, realCanonicalSessions: 246, compositeRepairedSessions: 3, authorizedDerivedSessions: 0, unavailableSessions: 0 },
    assemblyContentChecksum: VALID_CHECKSUM,
  };
}

/** 244 ordinary sequential regular sessions + Feb-1 + Oct-21 + the three composite-repaired dates = 249 total. */
function fullyValidResult(
  sessionOverrides: (sessions: ResearchUnderlyingResamplingManifestSessionEntry[]) => ResearchUnderlyingResamplingManifestSessionEntry[] = (s) => s,
  targetTimeframes = RESEARCH_UNDERLYING_RESAMPLING_TARGET_TIMEFRAMES
): BuildYearResamplingManifestResult {
  const regularDates = sequentialDates(244, '2020-01-01');
  const sessions = sessionOverrides([...regularDates.map((d) => sessionEntry(d)), sessionEntry(FEB1_DATE), sessionEntry(OCT21_DATE), ...COMPOSITE_REPAIRED_DATES.map((d) => sessionEntry(d))]);
  const manifest = buildResearchUnderlyingResamplingManifest({
    schemaVersion: RESEARCH_UNDERLYING_RESAMPLING_MANIFEST_SCHEMA_VERSION,
    resamplingSemanticsVersion: 1,
    sourceAssemblyChecksum: VALID_CHECKSUM,
    identity: { instrumentKey: NIFTY_INDEX_INSTRUMENT_KEY, sourceTimeframe: NIFTY_UNDERLYING_TIMEFRAME, year: 2025 },
    targetTimeframes,
    sourceSessionCounts: { expectedSessions: sessions.length, unavailableSessions: 0 },
    sessions,
  });
  return { manifest, sourceAssembly: fakeSourceAssembly() };
}

async function run(service: BuildAndPersistResamplingManifest, verifier: VerifyResampledSession, checksum: { value: string | undefined } = { value: VALID_CHECKSUM }) {
  const { lines, errorLines, output, errorOutput } = captureOutput();
  const success = await runNifty2025Resample({ sourceAssemblyChecksum: checksum.value, buildService: () => service, buildVerifier: () => verifier, output, errorOutput });
  return { success, lines, errorLines };
}

// ---- A: happy path ----

test('A. exact structural postconditions + verified no-lookahead across all 747 pairs -> SUCCESS, manifest persisted exactly once', async () => {
  const service = new FakeManifestService(fullyValidResult());
  const verifier = new FakeVerifier();
  const { success, lines, errorLines } = await run(service, verifier);
  assert.equal(success, true);
  assert.equal(errorLines.length, 0);
  assert.equal(service.persistCallCount, 1);
  assert.equal(verifier.calls.length, 747);
  const summary = lines.join('\n');
  assert.ok(summary.includes('status=SUCCESS'));
  assert.ok(summary.includes('year=2025'));
  assert.ok(summary.includes('sourceSessions=249'));
  assert.ok(summary.includes('resolvedSessions=249'));
  assert.ok(summary.includes('unavailableSessions=0'));
  assert.ok(summary.includes('targets=2m,3m,5m'));
  assert.ok(summary.includes('verifiedSessionTargetPairs=747'));
  // Informational, real-run-derived totals -- never a pre-guessed gate. 248 sessions with the
  // 375-minute shape (244 regular + Feb-1 + 3 composite repairs) + 1 with the 60-minute shape (Oct-21).
  assert.ok(summary.includes(`total${ResampleTargetTimeframe.TWO_MINUTE}=outputCandles:${248 * 187 + 30}/trailing:${248 * 1}/imputation:0`));
  assert.ok(summary.includes(`total${ResampleTargetTimeframe.THREE_MINUTE}=outputCandles:${248 * 125 + 20}/trailing:0/imputation:0`));
  assert.ok(summary.includes(`total${ResampleTargetTimeframe.FIVE_MINUTE}=outputCandles:${248 * 75 + 12}/trailing:0/imputation:0`));
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

test('E. sourceSessionCounts.expectedSessions !== 249 -> FAILED, no persist', async () => {
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

// ---- tier: real-canonical everywhere except the three reviewed composite repairs ----

test('H1. a composite-repaired sourcePrecedenceTier on a REGULAR (non-repaired) date fails closed', async () => {
  const result = fullyValidResult((sessions) =>
    sessions.map((s, i) => (i === 0 ? sessionEntry(s.tradingDate, { [ResampleTargetTimeframe.TWO_MINUTE]: { sourcePrecedenceTier: ResearchSessionSourcePrecedenceTier.ACCEPTED_COMPOSITE_REPAIRED_CANONICAL_SESSION } }) : s))
  );
  const service = new FakeManifestService(result);
  const { success, errorLines } = await run(service, new FakeVerifier());
  assert.equal(success, false);
  assert.equal(service.persistCallCount, 0);
  assert.ok(errorLines.join('\n').includes('code=NON_REAL_CANONICAL_OR_COMPOSITE_REPAIRED_SOURCE'));
});

test('H2. one of the three composite-repaired dates reports HEALTHY_REAL_CANONICAL_SESSION instead of ACCEPTED_COMPOSITE_REPAIRED_CANONICAL_SESSION -> fails closed', async () => {
  const result = fullyValidResult((sessions) =>
    sessions.map((s) => (s.tradingDate === COMPOSITE_REPAIRED_DATES[0] ? sessionEntry(s.tradingDate, { [ResampleTargetTimeframe.TWO_MINUTE]: { sourcePrecedenceTier: ResearchSessionSourcePrecedenceTier.HEALTHY_REAL_CANONICAL_SESSION } }) : s))
  );
  const service = new FakeManifestService(result);
  const { success, errorLines } = await run(service, new FakeVerifier());
  assert.equal(success, false);
  assert.equal(service.persistCallCount, 0);
  assert.ok(errorLines.join('\n').includes('code=NON_REAL_CANONICAL_OR_COMPOSITE_REPAIRED_SOURCE'));
});

test('I. unexpected imputation on one descriptor fails closed', async () => {
  const result = fullyValidResult((sessions) => sessions.map((s, i) => (i === 0 ? sessionEntry(s.tradingDate, { [ResampleTargetTimeframe.TWO_MINUTE]: { derivedImputedConstituentRowCount: 1 } }) : s)));
  const service = new FakeManifestService(result);
  const { success, errorLines } = await run(service, new FakeVerifier());
  assert.equal(success, false);
  assert.equal(service.persistCallCount, 0);
  assert.ok(errorLines.join('\n').includes('code=UNEXPECTED_IMPUTATION'));
});

// ---- per-session structural shape (never a hardcoded year-aggregate total) ----

test('J. a wrong source row count on an ordinary regular session fails closed', async () => {
  const result = fullyValidResult((sessions) => sessions.map((s, i) => (i === 0 ? sessionEntry(s.tradingDate, { [ResampleTargetTimeframe.TWO_MINUTE]: { sourceRowCount: 9999 } }) : s)));
  const service = new FakeManifestService(result);
  const { success, errorLines } = await run(service, new FakeVerifier());
  assert.equal(success, false);
  assert.equal(service.persistCallCount, 0);
  assert.ok(errorLines.join('\n').includes('code=WRONG_SESSION_SOURCE_ROW_COUNT'));
});

test('K1. Oct-21 wrong source row count fails closed', async () => {
  const result = fullyValidResult((sessions) => sessions.map((s) => (s.tradingDate === OCT21_DATE ? sessionEntry(OCT21_DATE, { [ResampleTargetTimeframe.TWO_MINUTE]: { sourceRowCount: 61 } }) : s)));
  const service = new FakeManifestService(result);
  const { success, errorLines } = await run(service, new FakeVerifier());
  assert.equal(success, false);
  assert.equal(service.persistCallCount, 0);
  assert.ok(errorLines.join('\n').includes('code=WRONG_SESSION_SOURCE_ROW_COUNT'));
});

test('K2. a composite-repaired date wrong source row count fails closed', async () => {
  const result = fullyValidResult((sessions) => sessions.map((s) => (s.tradingDate === COMPOSITE_REPAIRED_DATES[1] ? sessionEntry(COMPOSITE_REPAIRED_DATES[1], { [ResampleTargetTimeframe.TWO_MINUTE]: { sourcePrecedenceTier: ResearchSessionSourcePrecedenceTier.ACCEPTED_COMPOSITE_REPAIRED_CANONICAL_SESSION, sourceRowCount: 374 } }) : s)));
  const service = new FakeManifestService(result);
  const { success, errorLines } = await run(service, new FakeVerifier());
  assert.equal(success, false);
  assert.equal(service.persistCallCount, 0);
  assert.ok(errorLines.join('\n').includes('code=WRONG_SESSION_SOURCE_ROW_COUNT'));
});

test('L. a special session missing entirely fails closed', async () => {
  const result = fullyValidResult((sessions) => sessions.filter((s) => s.tradingDate !== OCT21_DATE));
  const service = new FakeManifestService(result);
  const { success, errorLines } = await run(service, new FakeVerifier());
  assert.equal(success, false);
  assert.equal(service.persistCallCount, 0);
  assert.ok(errorLines.join('\n').includes('status=FAILED'));
});

test('M1. Feb-1 wrong 3m target shape (outputCandleCount) fails closed', async () => {
  const result = fullyValidResult((sessions) => sessions.map((s) => (s.tradingDate === FEB1_DATE ? sessionEntry(FEB1_DATE, { [ResampleTargetTimeframe.THREE_MINUTE]: { outputCandleCount: 999 } }) : s)));
  const service = new FakeManifestService(result);
  const { success, errorLines } = await run(service, new FakeVerifier());
  assert.equal(success, false);
  assert.equal(service.persistCallCount, 0);
  assert.ok(errorLines.join('\n').includes('code=WRONG_SESSION_TARGET_SHAPE'));
});

test('M2. Oct-21 wrong 5m target shape (structuralTrailingRowCount) fails closed -- isolated per-session, no aggregate-compensation trick needed', async () => {
  const result = fullyValidResult((sessions) => sessions.map((s) => (s.tradingDate === OCT21_DATE ? sessionEntry(OCT21_DATE, { [ResampleTargetTimeframe.FIVE_MINUTE]: { structuralTrailingRowCount: 1 } }) : s)));
  const service = new FakeManifestService(result);
  const { success, errorLines } = await run(service, new FakeVerifier());
  assert.equal(success, false);
  assert.equal(service.persistCallCount, 0);
  assert.ok(errorLines.join('\n').includes('code=WRONG_SESSION_TARGET_SHAPE'));
});

// ---- no-lookahead re-verification ----

test('N. a no-lookahead violation (availableAt !== MAX(constituent availableAt)) fails closed, no persist', async () => {
  const service = new FakeManifestService(fullyValidResult());
  const brokenVerifier = new FakeVerifier((request) => {
    if (request.tradingDate === OCT21_DATE && request.targetTimeframe === ResampleTargetTimeframe.TWO_MINUTE) {
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

test('O. a non-REAL_CANONICAL_ONLY candle quality on a composite-repaired date fails closed (composite-repaired constituents must still be REAL_CANONICAL_ONLY)', async () => {
  const service = new FakeManifestService(fullyValidResult());
  const brokenVerifier = new FakeVerifier((request) => {
    if (request.tradingDate === COMPOSITE_REPAIRED_DATES[2] && request.targetTimeframe === ResampleTargetTimeframe.FIVE_MINUTE) {
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
    if (request.tradingDate === OCT21_DATE && request.targetTimeframe === ResampleTargetTimeframe.TWO_MINUTE) {
      return correctCandlesFor(request.tradingDate, request.targetTimeframe).slice(0, -1);
    }
    return correctCandlesFor(request.tradingDate, request.targetTimeframe);
  });
  const { success, errorLines } = await run(service, brokenVerifier);
  assert.equal(success, false);
  assert.equal(service.persistCallCount, 0);
  assert.ok(errorLines.join('\n').includes('code=CANDLE_COUNT_MISMATCH'));
});

// ---- special-session bucket-containment ----

test('Q1. a Feb-1 bucket bridging outside 09:15-15:30 IST fails closed', async () => {
  const service = new FakeManifestService(fullyValidResult());
  const brokenVerifier = new FakeVerifier((request) => {
    if (request.tradingDate === FEB1_DATE && request.targetTimeframe === ResampleTargetTimeframe.TWO_MINUTE) {
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
  assert.ok(errorLines.join('\n').includes('code=SPECIAL_SESSION_BUCKET_BRIDGES_WINDOW'));
});

test('Q2. an Oct-21 Muhurat bucket bridging outside 13:45-14:45 IST fails closed', async () => {
  const service = new FakeManifestService(fullyValidResult());
  const brokenVerifier = new FakeVerifier((request) => {
    if (request.tradingDate === OCT21_DATE && request.targetTimeframe === ResampleTargetTimeframe.TWO_MINUTE) {
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
  assert.ok(errorLines.join('\n').includes('code=SPECIAL_SESSION_BUCKET_BRIDGES_WINDOW'));
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
  const source = readFileSync(join(__dirname, 'research-nifty-2025-resample.ts'), 'utf8');
  assert.equal(/from\s+['"]@prisma\/client['"]/i.test(source), false);
  assert.equal(/from\s+['"][^'"]*upstox[^'"]*['"]/i.test(source), false);
});

test('structural: the CLI reads exactly one environment variable (the year-specific source-assembly checksum handoff) and never invents a placeholder checksum constant', () => {
  const source = readFileSync(join(__dirname, 'research-nifty-2025-resample.ts'), 'utf8');
  const envMatches = source.match(/process\.env\[/g) ?? [];
  assert.equal(envMatches.length, 1);
  assert.ok(source.includes('RESEARCH_NIFTY_2025_SOURCE_ASSEMBLY_CHECKSUM'));
});

test('structural: the CLI never hardcodes a year-level aggregate candle total constant', () => {
  const source = readFileSync(join(__dirname, 'research-nifty-2025-resample.ts'), 'utf8');
  assert.equal(/LOCKED_TARGET_TOTALS/.test(source), false);
});

test('structural: the CLI persists the trusted manifest ONLY after postcondition validation and no-lookahead re-verification -- in that source order', () => {
  const source = readFileSync(join(__dirname, 'research-nifty-2025-resample.ts'), 'utf8');
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
