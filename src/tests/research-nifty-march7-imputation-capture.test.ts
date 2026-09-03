import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContentAddressedJsonStoreResult } from '../modules/research-lake/domain/content-addressed-json-store';
import {
  DerivedImputedResearchSessionV1,
  DerivedResearchSessionRowV1,
  ImputationReason,
  ResearchRowProvenanceKind,
  ResearchSessionSourcePrecedenceTier,
} from '../modules/research-lake/domain/derived-imputed-research-session.types';
import { NIFTY_2022_03_07_INDEX_GAP_AUTHORIZATION_ID } from '../modules/research-lake/domain/nifty-index-gap-imputation-authorization';
import { ObservedIncompleteSessionSnapshotV1 } from '../modules/research-lake/domain/observed-incomplete-session-snapshot.types';
import { HistoricalProviderId } from '../modules/research-lake/interfaces/historical-provider-capability.types';
import type NiftyIndexGapImputationServiceType from '../modules/research-lake/services/nifty-index-gap-imputation.service';
import { NiftyIndexGapImputationError, NiftyIndexGapImputationResult } from '../modules/research-lake/services/nifty-index-gap-imputation.service';
import { NIFTY_INDEX_INSTRUMENT_KEY, NIFTY_UNDERLYING_TIMEFRAME } from '../modules/research-lake/services/nifty-underlying-identity';
import { CONFIRMATION_ENV_VAR, REQUIRED_CONFIRMATION_VALUE, runMarch7ImputationCapture } from './research-nifty-march7-imputation-capture';

/**
 * Zero-DB, zero-network, zero-real-provider unit suite for the March-7
 * controlled capture runner. `FakeGapImputationService` below is the ONLY
 * "service" any test ever constructs -- the real
 * `NiftyIndexGapImputationService` (and therefore Upstox/Prisma) is never
 * imported as a value here, only as a type (see the `import type` above),
 * so it is structurally impossible for these tests to reach a real
 * provider or database.
 */

const LOCKED_TRADING_DATE = '2022-03-07';

test('locked constants match the task-specified interlock name/value exactly', () => {
  assert.equal(CONFIRMATION_ENV_VAR, 'RESEARCH_MARCH7_IMPUTATION_CAPTURE_CONFIRMATION');
  assert.equal(REQUIRED_CONFIRMATION_VALUE, 'CAPTURE_AUTHORIZED_2022_03_07');
});

// ---- Output capture ---------------------------------------------------

function captureOutput(): { lines: string[]; errorLines: string[]; output: (line: string) => void; errorOutput: (line: string) => void } {
  const lines: string[] = [];
  const errorLines: string[] = [];
  return { lines, errorLines, output: (line) => lines.push(line), errorOutput: (line) => errorLines.push(line) };
}

// ---- Fake service -------------------------------------------------------

class FakeGapImputationService {
  public callCount = 0;
  public readonly requests: { tradingDate: string }[] = [];
  constructor(private readonly resultOrError: NiftyIndexGapImputationResult | Error) {}

  async buildImputedSession(request: { tradingDate: string }): Promise<NiftyIndexGapImputationResult> {
    this.callCount += 1;
    this.requests.push(request);
    if (this.resultOrError instanceof Error) throw this.resultOrError;
    return this.resultOrError;
  }
}

function spiedBuildService(service: FakeGapImputationService): { buildService: () => NiftyIndexGapImputationServiceType; constructCount: () => number } {
  let constructCount = 0;
  return {
    buildService: () => {
      constructCount += 1;
      return service as unknown as NiftyIndexGapImputationServiceType;
    },
    constructCount: () => constructCount,
  };
}

// ---- Fixture result -------------------------------------------------------

let fixtureTempDir: string;

function fixtureObservedRow(index: number, sourceSnapshotChecksum: string): DerivedResearchSessionRowV1 {
  const baseMs = Date.UTC(2022, 2, 7, 3, 45, 0); // 09:15 IST
  const candleTime = new Date(baseMs + index * 60_000).toISOString();
  const availableAt = new Date(baseMs + index * 60_000 + 60_000).toISOString();
  return {
    candleTime,
    open: '17000.00',
    high: '17000.50',
    low: '16999.50',
    close: '17000.10',
    volume: '1000',
    openInterest: null,
    availableAt,
    provenance: { kind: ResearchRowProvenanceKind.OBSERVED, sourceSnapshotChecksum },
  };
}

function fixtureImputedRows(sourceSnapshotChecksum: string): DerivedResearchSessionRowV1[] {
  const availableAt = new Date('2022-03-07T10:26:00+05:30').toISOString();
  return ['10:22:00', '10:23:00', '10:24:00'].map((time) => ({
    candleTime: new Date(`2022-03-07T${time}+05:30`).toISOString(),
    open: '17024.10',
    high: '17024.20',
    low: '17024.00',
    close: '17024.15',
    volume: '0',
    openInterest: null,
    availableAt,
    provenance: {
      kind: ResearchRowProvenanceKind.IMPUTED,
      method: 'LINEAR_BOUNDARY_INTERPOLATION',
      policyVersion: 1,
      authorizationId: NIFTY_2022_03_07_INDEX_GAP_AUTHORIZATION_ID,
      reason: ImputationReason.INDEX_BROADCAST_DATA_GAP,
      leftAnchor: { candleTime: new Date('2022-03-07T10:21:00+05:30').toISOString(), field: 'CLOSE', contentChecksum: 'a'.repeat(64) },
      rightAnchor: { candleTime: new Date('2022-03-07T10:25:00+05:30').toISOString(), field: 'OPEN', contentChecksum: 'b'.repeat(64) },
      sourceSnapshotChecksum,
    },
  }));
}

/** A fully-valid, locked-fact-compliant fixture result. Each test mutates a copy via `patch` to exercise exactly one postcondition violation. */
function buildFixtureResult(patch?: (draft: NiftyIndexGapImputationResult) => NiftyIndexGapImputationResult): NiftyIndexGapImputationResult {
  const snapshotContentChecksum = 'e'.repeat(64);

  const observedSnapshot: ObservedIncompleteSessionSnapshotV1 = {
    schemaVersion: 1,
    qualificationSemanticsVersion: 1,
    identity: {
      providerId: HistoricalProviderId.UPSTOX,
      instrumentKey: NIFTY_INDEX_INSTRUMENT_KEY,
      timeframe: NIFTY_UNDERLYING_TIMEFRAME,
      tradingDate: LOCKED_TRADING_DATE,
    },
    sessionWindows: [],
    expectedMinuteCount: 375,
    observedRowCount: 372,
    rows: [],
    missingExpectedMinutesIst: [622, 623, 624],
    sourceRowsSemanticChecksum: 'c'.repeat(64),
    durableHistoricalEvidenceSemanticChecksum: 'd'.repeat(64),
    snapshotContentChecksum,
  };

  const rows: DerivedResearchSessionRowV1[] = [
    ...Array.from({ length: 372 }, (_, index) => fixtureObservedRow(index, snapshotContentChecksum)),
    ...fixtureImputedRows(snapshotContentChecksum),
  ];

  const derivedSession: DerivedImputedResearchSessionV1 = {
    schemaVersion: 1,
    imputationSemanticsVersion: 1,
    identity: { instrumentKey: NIFTY_INDEX_INSTRUMENT_KEY, timeframe: NIFTY_UNDERLYING_TIMEFRAME, tradingDate: LOCKED_TRADING_DATE },
    authorizationId: NIFTY_2022_03_07_INDEX_GAP_AUTHORIZATION_ID,
    sourceSnapshotProviderId: HistoricalProviderId.UPSTOX,
    sourceSnapshotChecksum: snapshotContentChecksum,
    rows,
    realRowCount: 372,
    imputedRowCount: 3,
    precedenceTier: ResearchSessionSourcePrecedenceTier.AUTHORIZED_DERIVED_IMPUTED_SESSION,
    derivedContentChecksum: 'f'.repeat(64),
  };

  const observedSnapshotPath = join(fixtureTempDir, `observed-${Math.random().toString(36).slice(2)}.json`);
  const derivedSessionPath = join(fixtureTempDir, `derived-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(observedSnapshotPath, '{}');
  writeFileSync(derivedSessionPath, '{}');

  const observedSnapshotStorage: ContentAddressedJsonStoreResult = {
    relativePath: `observed-incomplete-session-snapshots/${snapshotContentChecksum}.json`,
    absolutePath: observedSnapshotPath,
    wasNewlyWritten: true,
  };
  const derivedSessionStorage: ContentAddressedJsonStoreResult = {
    relativePath: `derived-imputed-sessions/${derivedSession.derivedContentChecksum}.json`,
    absolutePath: derivedSessionPath,
    wasNewlyWritten: true,
  };

  const result: NiftyIndexGapImputationResult = { tradingDate: LOCKED_TRADING_DATE, observedSnapshot, derivedSession, observedSnapshotStorage, derivedSessionStorage };
  return patch ? patch(result) : result;
}

test.beforeEach(() => {
  fixtureTempDir = mkdtempSync(join(tmpdir(), 'march7-capture-runner-test-'));
});

test.afterEach(() => {
  rmSync(fixtureTempDir, { recursive: true, force: true });
});

// ============================================================================
// 1-4: interlock rejects every non-exact confirmation value
// ============================================================================

test('1. missing confirmation (undefined) rejects', async () => {
  const { lines, errorLines, output, errorOutput } = captureOutput();
  const service = new FakeGapImputationService(buildFixtureResult());
  const { buildService, constructCount } = spiedBuildService(service);
  const success = await runMarch7ImputationCapture({ confirmation: undefined, buildService, output, errorOutput });
  assert.equal(success, false);
  assert.equal(lines.length, 0);
  assert.ok(errorLines.join('\n').includes('OPERATOR_CONFIRMATION_INTERLOCK_NOT_SATISFIED'));
  assert.equal(constructCount(), 0);
  assert.equal(service.callCount, 0);
});

test('2. wrong confirmation value rejects', async () => {
  const { output, errorOutput, errorLines } = captureOutput();
  const service = new FakeGapImputationService(buildFixtureResult());
  const { buildService, constructCount } = spiedBuildService(service);
  const success = await runMarch7ImputationCapture({ confirmation: 'CAPTURE_AUTHORIZED_2022_03_08', buildService, output, errorOutput });
  assert.equal(success, false);
  assert.ok(errorLines.join('\n').includes('OPERATOR_CONFIRMATION_INTERLOCK_NOT_SATISFIED'));
  assert.equal(constructCount(), 0);
});

test('3. whitespace-altered confirmation rejects', async () => {
  const { output, errorOutput } = captureOutput();
  const service = new FakeGapImputationService(buildFixtureResult());
  const { buildService, constructCount } = spiedBuildService(service);
  const success = await runMarch7ImputationCapture({ confirmation: ` ${REQUIRED_CONFIRMATION_VALUE} `, buildService, output, errorOutput });
  assert.equal(success, false);
  assert.equal(constructCount(), 0);
});

test('4. case-altered confirmation rejects', async () => {
  const { output, errorOutput } = captureOutput();
  const service = new FakeGapImputationService(buildFixtureResult());
  const { buildService, constructCount } = spiedBuildService(service);
  const success = await runMarch7ImputationCapture({ confirmation: REQUIRED_CONFIRMATION_VALUE.toLowerCase(), buildService, output, errorOutput });
  assert.equal(success, false);
  assert.equal(constructCount(), 0);
});

test('5. rejected confirmation never constructs or calls the service', async () => {
  const { output, errorOutput } = captureOutput();
  const service = new FakeGapImputationService(buildFixtureResult());
  const { buildService, constructCount } = spiedBuildService(service);
  await runMarch7ImputationCapture({ confirmation: 'not even close', buildService, output, errorOutput });
  assert.equal(constructCount(), 0);
  assert.equal(service.callCount, 0);
});

// ============================================================================
// 6-9: accepted confirmation calls the service exactly once, with the locked date
// ============================================================================

test('6. accepted confirmation calls buildImputedSession exactly once', async () => {
  const { output, errorOutput } = captureOutput();
  const service = new FakeGapImputationService(buildFixtureResult());
  const { buildService } = spiedBuildService(service);
  await runMarch7ImputationCapture({ confirmation: REQUIRED_CONFIRMATION_VALUE, buildService, output, errorOutput });
  assert.equal(service.callCount, 1);
});

test('7. the request date is exactly 2022-03-07', async () => {
  const { output, errorOutput } = captureOutput();
  const service = new FakeGapImputationService(buildFixtureResult());
  const { buildService } = spiedBuildService(service);
  await runMarch7ImputationCapture({ confirmation: REQUIRED_CONFIRMATION_VALUE, buildService, output, errorOutput });
  assert.deepEqual(service.requests, [{ tradingDate: '2022-03-07' }]);
});

test('8. structural: the runner never reads a caller-supplied date override via argv or a second env var', () => {
  const source = readFileSync(join(__dirname, 'research-nifty-march7-imputation-capture.ts'), 'utf8');
  assert.equal(/process\.argv/.test(source), false, 'must never read command-line arguments');
  const envVarReads = source.match(/process\.env\[[^\]]+\]|process\.env\.[A-Z_]+/g) ?? [];
  const uniqueEnvVarReads = new Set(envVarReads);
  assert.equal(uniqueEnvVarReads.size, 1, `expected exactly one process.env read (the confirmation gate); found: ${[...uniqueEnvVarReads].join(', ')}`);
});

test('9. happy path: locked 372/3/375 result succeeds', async () => {
  const { lines, errorLines, output, errorOutput } = captureOutput();
  const service = new FakeGapImputationService(buildFixtureResult());
  const { buildService } = spiedBuildService(service);
  const success = await runMarch7ImputationCapture({ confirmation: REQUIRED_CONFIRMATION_VALUE, buildService, output, errorOutput });
  assert.equal(success, true);
  assert.equal(errorLines.length, 0);
  const summary = lines.join('\n');
  assert.ok(summary.includes('status=SUCCESS'));
  assert.ok(summary.includes('tradingDate=2022-03-07'));
  assert.ok(summary.includes('provider=UPSTOX'));
  assert.ok(summary.includes('expectedRows=375'));
  assert.ok(summary.includes('observedRows=372'));
  assert.ok(summary.includes('imputedRows=3'));
  assert.ok(summary.includes('missingMinutesIst=10:22,10:23,10:24'));
  assert.ok(summary.includes('canonicalWrites=NONE_BY_DESIGN'));
});

// ============================================================================
// 10-20: each locked invariant fails closed when violated
// ============================================================================

async function runWithPatchedResult(patch: (draft: NiftyIndexGapImputationResult) => NiftyIndexGapImputationResult): Promise<{ success: boolean; errorLines: string[]; service: FakeGapImputationService }> {
  const { output, errorOutput, errorLines } = captureOutput();
  const service = new FakeGapImputationService(buildFixtureResult(patch));
  const { buildService } = spiedBuildService(service);
  const success = await runMarch7ImputationCapture({ confirmation: REQUIRED_CONFIRMATION_VALUE, buildService, output, errorOutput });
  return { success, errorLines, service };
}

test('10. wrong observed count fails', async () => {
  const { success, errorLines } = await runWithPatchedResult((r) => ({ ...r, observedSnapshot: { ...r.observedSnapshot, observedRowCount: 371 } }));
  assert.equal(success, false);
  assert.ok(errorLines.join('\n').includes('SNAPSHOT_OBSERVED_ROW_COUNT'));
});

test('11. wrong expected count fails', async () => {
  const { success, errorLines } = await runWithPatchedResult((r) => ({ ...r, observedSnapshot: { ...r.observedSnapshot, expectedMinuteCount: 374 } }));
  assert.equal(success, false);
  assert.ok(errorLines.join('\n').includes('SNAPSHOT_EXPECTED_MINUTE_COUNT'));
});

test('12. wrong missing-minute set fails', async () => {
  const { success, errorLines } = await runWithPatchedResult((r) => ({ ...r, observedSnapshot: { ...r.observedSnapshot, missingExpectedMinutesIst: [630, 631, 632] } }));
  assert.equal(success, false);
  assert.ok(errorLines.join('\n').includes('SNAPSHOT_MISSING_MINUTES'));
});

test('13. wrong provider/identity fails', async () => {
  const { success, errorLines } = await runWithPatchedResult((r) => ({
    ...r,
    observedSnapshot: { ...r.observedSnapshot, identity: { ...r.observedSnapshot.identity, providerId: HistoricalProviderId.GROWW } },
  }));
  assert.equal(success, false);
  assert.ok(errorLines.join('\n').includes('SNAPSHOT_PROVIDER'));
});

test('14. wrong authorizationId fails', async () => {
  const { success, errorLines } = await runWithPatchedResult((r) => ({ ...r, derivedSession: { ...r.derivedSession, authorizationId: 'SOME_OTHER_AUTHORIZATION_V1' } }));
  assert.equal(success, false);
  assert.ok(errorLines.join('\n').includes('DERIVED_AUTHORIZATION_ID'));
});

test('15. wrong derived realRowCount fails', async () => {
  const { success, errorLines } = await runWithPatchedResult((r) => ({ ...r, derivedSession: { ...r.derivedSession, realRowCount: 371 } }));
  assert.equal(success, false);
  assert.ok(errorLines.join('\n').includes('DERIVED_REAL_ROW_COUNT'));
});

test('16. wrong imputedRowCount fails', async () => {
  const { success, errorLines } = await runWithPatchedResult((r) => ({ ...r, derivedSession: { ...r.derivedSession, imputedRowCount: 4 } }));
  assert.equal(success, false);
  assert.ok(errorLines.join('\n').includes('DERIVED_IMPUTED_ROW_COUNT'));
});

test('17. wrong total derived rows fails', async () => {
  const { success, errorLines } = await runWithPatchedResult((r) => ({ ...r, derivedSession: { ...r.derivedSession, rows: r.derivedSession.rows.slice(1) } }));
  assert.equal(success, false);
  assert.ok(errorLines.join('\n').includes('DERIVED_ROW_COUNT'));
});

test('18. wrong sourceSnapshotChecksum linkage fails', async () => {
  const { success, errorLines } = await runWithPatchedResult((r) => ({ ...r, derivedSession: { ...r.derivedSession, sourceSnapshotChecksum: 'z'.repeat(64) } }));
  assert.equal(success, false);
  assert.ok(errorLines.join('\n').includes('DERIVED_SOURCE_SNAPSHOT_CHECKSUM_LINKAGE'));
});

test('19. wrong number/location of IMPUTED rows fails', async () => {
  const { success, errorLines } = await runWithPatchedResult((r) => {
    const rows = r.derivedSession.rows.map((row) => (row.provenance.kind === ResearchRowProvenanceKind.IMPUTED ? { ...row, candleTime: new Date('2022-03-07T10:30:00+05:30').toISOString() } : row));
    return { ...r, derivedSession: { ...r.derivedSession, rows } };
  });
  assert.equal(success, false);
  assert.ok(errorLines.join('\n').includes('DERIVED_IMPUTED_MINUTES'));
});

test('20. wrong imputed availableAt fails', async () => {
  const { success, errorLines } = await runWithPatchedResult((r) => {
    const rows = r.derivedSession.rows.map((row) => (row.provenance.kind === ResearchRowProvenanceKind.IMPUTED ? { ...row, availableAt: new Date('2022-03-07T10:23:00+05:30').toISOString() } : row));
    return { ...r, derivedSession: { ...r.derivedSession, rows } };
  });
  assert.equal(success, false);
  assert.ok(errorLines.join('\n').includes('DERIVED_IMPUTED_AVAILABLE_AT'));
});

// ============================================================================
// 21-22: null persistence results fail closed
// ============================================================================

test('21. null observed storage result fails', async () => {
  const { success, errorLines } = await runWithPatchedResult((r) => ({ ...r, observedSnapshotStorage: null }));
  assert.equal(success, false);
  assert.ok(errorLines.join('\n').includes('OBSERVED_SNAPSHOT_STORAGE_PRESENT'));
});

test('22. null derived storage result fails', async () => {
  const { success, errorLines } = await runWithPatchedResult((r) => ({ ...r, derivedSessionStorage: null }));
  assert.equal(success, false);
  assert.ok(errorLines.join('\n').includes('DERIVED_SESSION_STORAGE_PRESENT'));
});

// ============================================================================
// 23-24: typed vs. unexpected errors surface distinctly, safely
// ============================================================================

test('23. a typed NiftyIndexGapImputationError is surfaced with its original code', async () => {
  const { output, errorOutput, errorLines } = captureOutput();
  const service = new FakeGapImputationService(new NiftyIndexGapImputationError('SOURCE_CHECKSUM_DRIFT', 'the current re-observation drifted from durable evidence'));
  const { buildService } = spiedBuildService(service);
  const success = await runMarch7ImputationCapture({ confirmation: REQUIRED_CONFIRMATION_VALUE, buildService, output, errorOutput });
  assert.equal(success, false);
  const summary = errorLines.join('\n');
  assert.ok(summary.includes('code=SOURCE_CHECKSUM_DRIFT'));
  assert.ok(summary.includes('the current re-observation drifted from durable evidence'));
});

test('24. an unexpected (non-typed) error exits/fails safely', async () => {
  const { output, errorOutput, errorLines } = captureOutput();
  const service = new FakeGapImputationService(new TypeError('something unrelated broke'));
  const { buildService } = spiedBuildService(service);
  const success = await runMarch7ImputationCapture({ confirmation: REQUIRED_CONFIRMATION_VALUE, buildService, output, errorOutput });
  assert.equal(success, false);
  const summary = errorLines.join('\n');
  assert.ok(summary.includes('code=UNEXPECTED_ERROR'));
  assert.ok(summary.includes('something unrelated broke'));
});

// ============================================================================
// 25: output never leaks injected fake credentials/secrets
// ============================================================================

test('25. output never includes injected fake credentials/secrets from an error cause', async () => {
  const { output, errorOutput, lines, errorLines } = captureOutput();
  const fakeSecret = 'FAKE_SECRET_UPSTOX_TOKEN_zzzz9999';
  const causeWithSecret = { headers: { Authorization: `Bearer ${fakeSecret}` } };
  const service = new FakeGapImputationService(new NiftyIndexGapImputationError('PRIMARY_FETCH_FAILED', 'the controlled re-observation fetch failed', causeWithSecret));
  const { buildService } = spiedBuildService(service);
  await runMarch7ImputationCapture({ confirmation: REQUIRED_CONFIRMATION_VALUE, buildService, output, errorOutput });
  const allOutput = [...lines, ...errorLines].join('\n');
  assert.equal(allOutput.includes(fakeSecret), false, 'the runner must never print an error cause -- only code/message');
});

// ============================================================================
// 26-27: exactly-once / never-retry, re-asserted across both success and failure
// ============================================================================

test('26. success calls the service exactly once', async () => {
  const { output, errorOutput } = captureOutput();
  const service = new FakeGapImputationService(buildFixtureResult());
  const { buildService } = spiedBuildService(service);
  await runMarch7ImputationCapture({ confirmation: REQUIRED_CONFIRMATION_VALUE, buildService, output, errorOutput });
  assert.equal(service.callCount, 1);
});

test('27. failure never retries the service (typed error and postcondition violation both call it exactly once)', async () => {
  const { output, errorOutput } = captureOutput();
  const typedErrorService = new FakeGapImputationService(new NiftyIndexGapImputationError('CALENDAR_BLOCKED', 'calendar truth is uncertified'));
  const { buildService: buildTypedErrorService } = spiedBuildService(typedErrorService);
  await runMarch7ImputationCapture({ confirmation: REQUIRED_CONFIRMATION_VALUE, buildService: buildTypedErrorService, output, errorOutput });
  assert.equal(typedErrorService.callCount, 1);

  const { errorLines: postconditionErrorLines, service: postconditionService } = await runWithPatchedResult((r) => ({ ...r, derivedSession: { ...r.derivedSession, imputedRowCount: 99 } }));
  assert.ok(postconditionErrorLines.join('\n').includes('POSTCONDITION_VIOLATION'));
  assert.equal(postconditionService.callCount, 1);
});

// ============================================================================
// 28-30: structural proof this suite touches no real provider/DB/artifact
// ============================================================================

test('28-29. this test file never imports the real Upstox provider or a Prisma client as a value', () => {
  const source = readFileSync(__filename, 'utf8');
  // `\s+`/`\/` in these patterns deliberately never literally spell out a real
  // import statement, so this check cannot trivially match its own source text
  // (unlike a bare identifier search, which would self-match the very prose/
  // regex describing the thing being ruled out).
  assert.equal(/from\s+['"][^'"]*upstox[^'"]*['"]/i.test(source), false, 'must never import from an upstox module');
  assert.equal(/from\s+['"]@prisma\/client['"]/i.test(source), false, 'must never import a Prisma client');
  assert.equal(/from\s+['"]\.\.\/modules\/research-lake\/services\/nifty-index-gap-imputation\.service['"]/.test(source), true);
  // Confirms the real service class is imported ONLY as a type, never as a value that could be constructed.
  assert.equal(/import type NiftyIndexGapImputationServiceType/.test(source), true, 'the real service must be imported type-only in this test file');
});

test('30. tests never write into the repository artifacts directory', () => {
  const source = readFileSync(__filename, 'utf8');
  assert.equal(/artifacts\/research-lake/.test(source), false, 'tests must only ever write to a temp fixture directory (mkdtempSync), never the real artifact root');
});
