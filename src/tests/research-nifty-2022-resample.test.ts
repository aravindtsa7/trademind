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
import { NIFTY_INDEX_INSTRUMENT_KEY, NIFTY_UNDERLYING_TIMEFRAME } from '../modules/research-lake/services/nifty-underlying-identity';
import { BuildAndPersistResamplingManifest, VerifyResampledSession, runNifty2022Resample } from './research-nifty-2022-resample';
import { BuildYearResamplingManifestResult } from '../modules/research-lake/services/research-underlying-resampling-manifest-builder.service';
import { ReadResampledSessionRequest, ReadResampledSessionResult } from '../modules/research-lake/services/research-underlying-resampled-session-reader.service';

const LOCKED_SOURCE_ASSEMBLY_CHECKSUM = '8506497dfdb15f4a1e7da08d43e64a6a21928252e251312c771d7195ba19ecdb';
const MARCH_7_DATE = '2022-03-07';
const MARCH_7_DAY_START_MS = new Date(`${MARCH_7_DATE}T00:00:00+05:30`).getTime();

function march7Minute(minuteOfDay: number): Date {
  return new Date(MARCH_7_DAY_START_MS + minuteOfDay * 60_000);
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

function fakeCandle(bucketStart: Date, availableAt: Date): ResearchResampledCandle {
  return {
    bucketStart,
    bucketEnd: bucketStart,
    availableAt,
    open: new Prisma.Decimal(0),
    high: new Prisma.Decimal(0),
    low: new Prisma.Decimal(0),
    close: new Prisma.Decimal(0),
    volume: 0n,
    openInterest: null,
    quality: ResearchCandleQuality.CONTAINS_AUTHORIZED_IMPUTATION,
    constituents: [],
  };
}

function correctCandlesFor(targetTimeframe: ResampleTargetTimeframe): ResearchResampledCandle[] {
  if (targetTimeframe === ResampleTargetTimeframe.TWO_MINUTE) {
    return [fakeCandle(march7Minute(621), march7Minute(626)), fakeCandle(march7Minute(623), march7Minute(626))];
  }
  if (targetTimeframe === ResampleTargetTimeframe.THREE_MINUTE) {
    return [fakeCandle(march7Minute(621), march7Minute(626)), fakeCandle(march7Minute(624), march7Minute(627))];
  }
  return [fakeCandle(march7Minute(620), march7Minute(626))];
}

class FakeVerifier implements VerifyResampledSession {
  public calls: ReadResampledSessionRequest[] = [];
  constructor(
    private readonly candlesByTarget: Partial<Record<ResampleTargetTimeframe, ResearchResampledCandle[]>> = {},
    private readonly throwError?: Error
  ) {}
  async readResampledSession(request: ReadResampledSessionRequest): Promise<ReadResampledSessionResult> {
    this.calls.push(request);
    if (this.throwError) throw this.throwError;
    const candles = this.candlesByTarget[request.targetTimeframe] ?? correctCandlesFor(request.targetTimeframe);
    return { candles, descriptor: {} as ResearchResampleSessionDescriptor };
  }
}

function correctVerifier(): FakeVerifier {
  return new FakeVerifier({
    [ResampleTargetTimeframe.TWO_MINUTE]: correctCandlesFor(ResampleTargetTimeframe.TWO_MINUTE),
    [ResampleTargetTimeframe.THREE_MINUTE]: correctCandlesFor(ResampleTargetTimeframe.THREE_MINUTE),
    [ResampleTargetTimeframe.FIVE_MINUTE]: correctCandlesFor(ResampleTargetTimeframe.FIVE_MINUTE),
  });
}

function genericDescriptor(tradingDate: string, targetTimeframe: ResampleTargetTimeframe, overrides: Partial<ResearchResampleSessionDescriptor> = {}): ResearchResampleSessionDescriptor {
  return {
    researchResamplingSchemaVersion: 1,
    researchResamplingSemanticsVersion: 1,
    sourceAssemblyChecksum: LOCKED_SOURCE_ASSEMBLY_CHECKSUM,
    tradingDate,
    sourcePrecedenceTier: ResearchSessionSourcePrecedenceTier.HEALTHY_REAL_CANONICAL_SESSION,
    sourceContentChecksum: 'c'.repeat(64),
    targetTimeframe,
    sessionWindows: [{ windowIndex: 0, openMinuteIst: 555, closeMinuteIst: 930 }],
    sourceRowCount: 375,
    expectedSourceMinuteCount: 375,
    outputCandleCount: targetTimeframe === ResampleTargetTimeframe.TWO_MINUTE ? 187 : targetTimeframe === ResampleTargetTimeframe.THREE_MINUTE ? 125 : 75,
    structuralTrailingRowCount: targetTimeframe === ResampleTargetTimeframe.TWO_MINUTE ? 1 : 0,
    missingSourceMinuteCount: 0,
    realCanonicalConstituentRowCount: 375,
    derivedObservedConstituentRowCount: 0,
    derivedImputedConstituentRowCount: 0,
    candlesContainingImputation: 0,
    researchDerivedContentChecksum: 'r'.repeat(64),
    status: ResearchResampleSessionStatus.COMPLETE_RESEARCH_SESSION,
    ...overrides,
  };
}

function march7Descriptors(overrides: Partial<Record<ResampleTargetTimeframe, Partial<ResearchResampleSessionDescriptor>>> = {}): ResearchUnderlyingResamplingManifestSessionEntry {
  return {
    tradingDate: MARCH_7_DATE,
    targets: {
      [ResampleTargetTimeframe.TWO_MINUTE]: genericDescriptor(MARCH_7_DATE, ResampleTargetTimeframe.TWO_MINUTE, {
        sourcePrecedenceTier: ResearchSessionSourcePrecedenceTier.AUTHORIZED_DERIVED_IMPUTED_SESSION,
        derivedImputedConstituentRowCount: 3,
        outputCandleCount: 187,
        structuralTrailingRowCount: 1,
        candlesContainingImputation: 2,
        ...overrides[ResampleTargetTimeframe.TWO_MINUTE],
      }),
      [ResampleTargetTimeframe.THREE_MINUTE]: genericDescriptor(MARCH_7_DATE, ResampleTargetTimeframe.THREE_MINUTE, {
        sourcePrecedenceTier: ResearchSessionSourcePrecedenceTier.AUTHORIZED_DERIVED_IMPUTED_SESSION,
        derivedImputedConstituentRowCount: 3,
        outputCandleCount: 125,
        structuralTrailingRowCount: 0,
        candlesContainingImputation: 2,
        ...overrides[ResampleTargetTimeframe.THREE_MINUTE],
      }),
      [ResampleTargetTimeframe.FIVE_MINUTE]: genericDescriptor(MARCH_7_DATE, ResampleTargetTimeframe.FIVE_MINUTE, {
        sourcePrecedenceTier: ResearchSessionSourcePrecedenceTier.AUTHORIZED_DERIVED_IMPUTED_SESSION,
        derivedImputedConstituentRowCount: 3,
        outputCandleCount: 75,
        structuralTrailingRowCount: 0,
        candlesContainingImputation: 1,
        ...overrides[ResampleTargetTimeframe.FIVE_MINUTE],
      }),
    },
  };
}

function genericSessionEntry(tradingDate: string): ResearchUnderlyingResamplingManifestSessionEntry {
  return {
    tradingDate,
    targets: {
      [ResampleTargetTimeframe.TWO_MINUTE]: genericDescriptor(tradingDate, ResampleTargetTimeframe.TWO_MINUTE),
      [ResampleTargetTimeframe.THREE_MINUTE]: genericDescriptor(tradingDate, ResampleTargetTimeframe.THREE_MINUTE),
      [ResampleTargetTimeframe.FIVE_MINUTE]: genericDescriptor(tradingDate, ResampleTargetTimeframe.FIVE_MINUTE),
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
    identity: { instrumentKey: NIFTY_INDEX_INSTRUMENT_KEY, timeframe: NIFTY_UNDERLYING_TIMEFRAME, year: 2022 },
    canonicalManifest: { datasetKind: ManifestDatasetKind.UNDERLYING_1M, datasetId: 'UNDERLYING_1M_abc', datasetChecksum: 'f'.repeat(64), manifestSchemaVersion: 5, canonicalizationVersion: 1, healthSemanticsVersion: 1 },
    sessions: [],
    sessionCounts: { expectedSessions: 248, researchReadySessions: 248, realCanonicalSessions: 247, compositeRepairedSessions: 0, authorizedDerivedSessions: 1, unavailableSessions: 0 },
    assemblyContentChecksum: LOCKED_SOURCE_ASSEMBLY_CHECKSUM,
  };
}

function fullyValidResult(sessionOverrides: (sessions: ResearchUnderlyingResamplingManifestSessionEntry[]) => ResearchUnderlyingResamplingManifestSessionEntry[] = (s) => s, targetTimeframes = RESEARCH_UNDERLYING_RESAMPLING_TARGET_TIMEFRAMES): BuildYearResamplingManifestResult {
  const genericDates = sequentialDates(247, '2020-01-01');
  const sessions = sessionOverrides([...genericDates.map((d) => genericSessionEntry(d)), march7Descriptors()]);
  const manifest = buildResearchUnderlyingResamplingManifest({
    schemaVersion: RESEARCH_UNDERLYING_RESAMPLING_MANIFEST_SCHEMA_VERSION,
    resamplingSemanticsVersion: 1,
    sourceAssemblyChecksum: LOCKED_SOURCE_ASSEMBLY_CHECKSUM,
    identity: { instrumentKey: NIFTY_INDEX_INSTRUMENT_KEY, sourceTimeframe: NIFTY_UNDERLYING_TIMEFRAME, year: 2022 },
    targetTimeframes,
    sourceSessionCounts: { expectedSessions: sessions.length, unavailableSessions: 0 },
    sessions,
  });
  return { manifest, sourceAssembly: fakeSourceAssembly() };
}

// ---- A: happy path ----

test('A. exact locked postconditions + verified no-lookahead proofs -> SUCCESS, manifest persisted exactly once', async () => {
  const { lines, errorLines, output, errorOutput } = captureOutput();
  const service = new FakeManifestService(fullyValidResult());
  const verifier = correctVerifier();
  const success = await runNifty2022Resample({ buildService: () => service, buildVerifier: () => verifier, output, errorOutput });
  assert.equal(success, true);
  assert.equal(errorLines.length, 0);
  assert.equal(service.persistCallCount, 1);
  assert.equal(verifier.calls.length, 3);
  const summary = lines.join('\n');
  assert.ok(summary.includes('status=SUCCESS'));
  assert.ok(summary.includes(`instrument=${NIFTY_INDEX_INSTRUMENT_KEY}`));
  assert.ok(summary.includes(`sourceTimeframe=${NIFTY_UNDERLYING_TIMEFRAME}`));
  assert.ok(summary.includes('year=2022'));
  assert.ok(summary.includes('sourceSessions=248'));
  assert.ok(summary.includes('resolvedSessions=248'));
  assert.ok(summary.includes('unavailableSessions=0'));
  assert.ok(summary.includes('targets=2m,3m,5m'));
  assert.ok(summary.includes('manifestContentChecksum='));
  assert.ok(summary.includes('manifestArtifact='));
});

// ---- B: wrong source assembly checksum ----

test('B. wrong sourceAssemblyChecksum -> FAILED, no persist, verifier never called', async () => {
  const { errorLines, output, errorOutput } = captureOutput();
  const result = fullyValidResult();
  const wrong = { ...result, manifest: { ...result.manifest, sourceAssemblyChecksum: '0'.repeat(64) } };
  const service = new FakeManifestService(wrong);
  const verifier = correctVerifier();
  const success = await runNifty2022Resample({ buildService: () => service, buildVerifier: () => verifier, output, errorOutput });
  assert.equal(success, false);
  assert.equal(service.persistCallCount, 0);
  assert.equal(verifier.calls.length, 0);
  assert.ok(errorLines.join('\n').includes('code=WRONG_SOURCE_ASSEMBLY_CHECKSUM'));
});

// ---- C: source session count wrong ----

test('C. sourceSessionCounts.expectedSessions !== 248 -> FAILED, no persist', async () => {
  const { errorLines, output, errorOutput } = captureOutput();
  const result = fullyValidResult();
  const wrong = { ...result, manifest: { ...result.manifest, sourceSessionCounts: { ...result.manifest.sourceSessionCounts, expectedSessions: 99 } } };
  const service = new FakeManifestService(wrong);
  const success = await runNifty2022Resample({ buildService: () => service, buildVerifier: () => correctVerifier(), output, errorOutput });
  assert.equal(success, false);
  assert.equal(service.persistCallCount, 0);
  assert.ok(errorLines.join('\n').includes('code=WRONG_SOURCE_SESSION_COUNT'));
});

// ---- D: unavailable sessions present ----

test('D. unavailableSessions !== 0 -> FAILED, no persist', async () => {
  const { errorLines, output, errorOutput } = captureOutput();
  const result = fullyValidResult();
  const wrong = { ...result, manifest: { ...result.manifest, sourceSessionCounts: { ...result.manifest.sourceSessionCounts, unavailableSessions: 1 } } };
  const service = new FakeManifestService(wrong);
  const success = await runNifty2022Resample({ buildService: () => service, buildVerifier: () => correctVerifier(), output, errorOutput });
  assert.equal(success, false);
  assert.equal(service.persistCallCount, 0);
  assert.ok(errorLines.join('\n').includes('code=UNAVAILABLE_SESSIONS_PRESENT'));
});

// ---- E/F: target timeframe set wrong ----

test('E. missing a target timeframe (2m,3m only) -> FAILED, no persist', async () => {
  const { errorLines, output, errorOutput } = captureOutput();
  const result = fullyValidResult((s) => s, [ResampleTargetTimeframe.TWO_MINUTE, ResampleTargetTimeframe.THREE_MINUTE]);
  const service = new FakeManifestService(result);
  const success = await runNifty2022Resample({ buildService: () => service, buildVerifier: () => correctVerifier(), output, errorOutput });
  assert.equal(success, false);
  assert.equal(service.persistCallCount, 0);
  assert.ok(errorLines.join('\n').includes('code=WRONG_TARGET_TIMEFRAME_SET'));
});

test('F. an extra target timeframe beyond 2m/3m/5m -> FAILED, no persist', async () => {
  const { errorLines, output, errorOutput } = captureOutput();
  const result = fullyValidResult((s) => s, [...RESEARCH_UNDERLYING_RESAMPLING_TARGET_TIMEFRAMES, '10m' as ResampleTargetTimeframe]);
  const service = new FakeManifestService(result);
  const success = await runNifty2022Resample({ buildService: () => service, buildVerifier: () => correctVerifier(), output, errorOutput });
  assert.equal(success, false);
  assert.equal(service.persistCallCount, 0);
  assert.ok(errorLines.join('\n').includes('code=WRONG_TARGET_TIMEFRAME_SET'));
});

// ---- G/H/I: March-7 wrong facts ----

test('G. March-7 not tier 3 -> FAILED, no persist', async () => {
  const { errorLines, output, errorOutput } = captureOutput();
  const result = fullyValidResult((sessions) =>
    sessions.map((s) => (s.tradingDate === MARCH_7_DATE ? march7Descriptors({ [ResampleTargetTimeframe.TWO_MINUTE]: { sourcePrecedenceTier: ResearchSessionSourcePrecedenceTier.HEALTHY_REAL_CANONICAL_SESSION } }) : s))
  );
  const service = new FakeManifestService(result);
  const success = await runNifty2022Resample({ buildService: () => service, buildVerifier: () => correctVerifier(), output, errorOutput });
  assert.equal(success, false);
  assert.equal(service.persistCallCount, 0);
  assert.ok(errorLines.join('\n').includes('code=MARCH7_NOT_TIER3'));
});

test('H. March-7 derivedImputedConstituentRowCount !== 3 -> FAILED, no persist', async () => {
  const { errorLines, output, errorOutput } = captureOutput();
  const result = fullyValidResult((sessions) => sessions.map((s) => (s.tradingDate === MARCH_7_DATE ? march7Descriptors({ [ResampleTargetTimeframe.TWO_MINUTE]: { derivedImputedConstituentRowCount: 4 } }) : s)));
  const service = new FakeManifestService(result);
  const success = await runNifty2022Resample({ buildService: () => service, buildVerifier: () => correctVerifier(), output, errorOutput });
  assert.equal(success, false);
  assert.equal(service.persistCallCount, 0);
  assert.ok(errorLines.join('\n').includes('code=MARCH7_WRONG_IMPUTED_COUNT'));
});

test('I. March-7 wrong 2m output-candle counts -> FAILED, no persist', async () => {
  const { errorLines, output, errorOutput } = captureOutput();
  const result = fullyValidResult((sessions) => sessions.map((s) => (s.tradingDate === MARCH_7_DATE ? march7Descriptors({ [ResampleTargetTimeframe.TWO_MINUTE]: { outputCandleCount: 999 } }) : s)));
  const service = new FakeManifestService(result);
  const success = await runNifty2022Resample({ buildService: () => service, buildVerifier: () => correctVerifier(), output, errorOutput });
  assert.equal(success, false);
  assert.equal(service.persistCallCount, 0);
  assert.ok(errorLines.join('\n').includes('code=MARCH7_WRONG_2M_COUNTS'));
});

// ---- J: build exception ----

test('J. buildYearManifest throws -> FAILED, non-zero, no persist attempted, verifier never called', async () => {
  const { lines, errorLines, output, errorOutput } = captureOutput();
  const service = new FakeManifestService(new Error('trusted assembly integrity check failed'));
  const verifier = correctVerifier();
  const success = await runNifty2022Resample({ buildService: () => service, buildVerifier: () => verifier, output, errorOutput });
  assert.equal(success, false);
  assert.equal(lines.length, 0);
  assert.equal(service.persistCallCount, 0);
  assert.equal(verifier.calls.length, 0);
  const summary = errorLines.join('\n');
  assert.ok(summary.includes('status=FAILED'));
  assert.ok(summary.includes('code=BUILD_FAILED'));
  assert.ok(summary.includes('trusted assembly integrity check failed'));
});

// ---- K: persistence exception after all validation passed ----

test('K. persistManifest throws even though every postcondition + proof passed -> FAILED, non-zero, no SUCCESS output', async () => {
  const { lines, errorLines, output, errorOutput } = captureOutput();
  const service = new FakeManifestService(fullyValidResult(), new Error('disk full'));
  const success = await runNifty2022Resample({ buildService: () => service, buildVerifier: () => correctVerifier(), output, errorOutput });
  assert.equal(success, false);
  assert.equal(lines.length, 0);
  assert.equal(service.persistCallCount, 1);
  const summary = errorLines.join('\n');
  assert.ok(summary.includes('code=PERSISTENCE_FAILED'));
  assert.ok(summary.includes('disk full'));
});

// ---- L: no-lookahead proof failure ----

test('L. an incorrect March-7 3m 10:24-10:26 availableAt (10:26 instead of the required 10:27) fails closed, no persist', async () => {
  const { errorLines, output, errorOutput } = captureOutput();
  const service = new FakeManifestService(fullyValidResult());
  const wrongVerifier = new FakeVerifier({
    [ResampleTargetTimeframe.TWO_MINUTE]: correctCandlesFor(ResampleTargetTimeframe.TWO_MINUTE),
    [ResampleTargetTimeframe.THREE_MINUTE]: [fakeCandle(march7Minute(621), march7Minute(626)), fakeCandle(march7Minute(624), march7Minute(626))], // WRONG: should be 10:27
    [ResampleTargetTimeframe.FIVE_MINUTE]: correctCandlesFor(ResampleTargetTimeframe.FIVE_MINUTE),
  });
  const success = await runNifty2022Resample({ buildService: () => service, buildVerifier: () => wrongVerifier, output, errorOutput });
  assert.equal(success, false);
  assert.equal(service.persistCallCount, 0);
  assert.ok(errorLines.join('\n').includes('code=MARCH7_3M_10_24_PROOF_FAILED'));
});

// ---- M: verifier throws ----

test('M. the verified read boundary throwing (e.g. checksum mismatch) fails closed, no persist', async () => {
  const { errorLines, output, errorOutput } = captureOutput();
  const service = new FakeManifestService(fullyValidResult());
  const throwingVerifier = new FakeVerifier({}, new Error('researchDerivedContentChecksum mismatch'));
  const success = await runNifty2022Resample({ buildService: () => service, buildVerifier: () => throwingVerifier, output, errorOutput });
  assert.equal(success, false);
  assert.equal(service.persistCallCount, 0);
  const summary = errorLines.join('\n');
  assert.ok(summary.includes('code=MARCH7_VERIFICATION_FAILED'));
  assert.ok(summary.includes('researchDerivedContentChecksum mismatch'));
});

// ---- structural ----

test('structural: this test file never imports the real manifest builder class, Prisma as a service dependency, or a provider client as a value', () => {
  const source = readFileSync(join(__dirname, 'research-nifty-2022-resample.ts'), 'utf8');
  assert.equal(/from\s+['"]@prisma\/client['"]/i.test(source), false);
  assert.equal(/from\s+['"][^'"]*upstox[^'"]*['"]/i.test(source), false);
  assert.equal(/ResearchUnderlyingResamplingManifestBuilderService\b.*resolveSessionRows|HistoricalCandleRepository|findRange/.test(source), false);
});

test('structural: the CLI never reads process.env (zero provider/network calls, no operator confirmation interlock needed)', () => {
  const source = readFileSync(join(__dirname, 'research-nifty-2022-resample.ts'), 'utf8');
  assert.equal(/process\.env/.test(source), false);
});

test('structural: the CLI persists the trusted manifest ONLY after both postcondition validation and no-lookahead proof validation -- in that source order', () => {
  const source = readFileSync(join(__dirname, 'research-nifty-2022-resample.ts'), 'utf8');
  const validateIndex = source.indexOf('validateLockedProductionPostconditions(result.manifest)');
  const proofIndex = source.indexOf('validateMarch7NoLookaheadProofs(verifier, result.manifest, result.sourceAssembly)');
  const persistIndex = source.indexOf('service.persistManifest(result.manifest)');
  assert.ok(validateIndex > 0 && proofIndex > 0 && persistIndex > 0);
  assert.ok(validateIndex < proofIndex && proofIndex < persistIndex, 'postcondition validation, then no-lookahead proof validation, then persistManifest -- in that order');
});

test('the service is called exactly once per run (buildYearManifest), and persistManifest at most once', async () => {
  const { output, errorOutput } = captureOutput();
  const service = new FakeManifestService(fullyValidResult());
  await runNifty2022Resample({ buildService: () => service, buildVerifier: () => correctVerifier(), output, errorOutput });
  assert.equal(service.buildCallCount, 1);
  assert.equal(service.persistCallCount, 1);
});
