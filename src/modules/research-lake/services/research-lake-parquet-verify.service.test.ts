import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Prisma } from '@prisma/client';
import DatasetManifestService from './dataset-manifest.service';
import DatasetSessionManifestBuilderService, { PersistedManifestCandleRow } from './dataset-session-manifest-builder.service';
import ResearchLakeParquetExportService from './research-lake-parquet-export.service';
import ResearchLakeParquetVerifyService from './research-lake-parquet-verify.service';
import { ParquetDatasetStorageDescriptor } from '../domain/parquet-storage.types';
import { DatasetManifest, MANIFEST_SCHEMA_VERSION } from '../domain/dataset-manifest.types';
import { HistoricalProviderId } from '../interfaces/historical-provider-capability.types';
import HistoricalCandleRepository from '../../historical-candles/repositories/historical-candle.repository';
import HistoricalOptionCandleLakeRepository from '../repositories/historical-option-candle-lake.repository';
import HistoricalDataRetrievalEvidenceService from './historical-data-retrieval-evidence.service';

/** B-F2C: see the identical constant's doc in research-lake-parquet-export.service.test.ts -- this suite tests Parquet verify/storage-descriptor behavior, not B-F2C evidence, so every manifest here truthfully has none. */
const NO_RETRIEVAL_EVIDENCE = { findLatestAvailableSessionEvidence: async () => null } as unknown as HistoricalDataRetrievalEvidenceService;

const INSTRUMENT_KEY = 'NSE_INDEX|Nifty 50';

function makeRow(candleTime: Date, overrides: Partial<PersistedManifestCandleRow> = {}): PersistedManifestCandleRow {
  return {
    candleTime,
    open: new Prisma.Decimal(100),
    high: new Prisma.Decimal(101),
    low: new Prisma.Decimal(99),
    close: new Prisma.Decimal(100.5),
    volume: 1_000n,
    openInterest: null,
    ...overrides,
  };
}

function normalSessionRows(tradingDate: string): PersistedManifestCandleRow[] {
  const start = new Date(`${tradingDate}T09:15:00+05:30`).getTime();
  return Array.from({ length: 375 }, (_, index) => makeRow(new Date(start + index * 60_000)));
}

class FakeHistoricalCandleRepository {
  rows: PersistedManifestCandleRow[] = [];
  async findRange(_instrumentKey: string, _timeframe: string, from: Date, to: Date): Promise<PersistedManifestCandleRow[]> {
    return this.rows.filter((row) => row.candleTime >= from && row.candleTime <= to).sort((a, b) => a.candleTime.getTime() - b.candleTime.getTime());
  }
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'bf6-parquet-verify-'));
}

async function buildAndExport(tradingDates: string[]): Promise<{ manifest: Awaited<ReturnType<DatasetManifestService['generateUnderlyingManifest']>>; descriptor: ParquetDatasetStorageDescriptor; outputRoot: string }> {
  const candleRepo = new FakeHistoricalCandleRepository();
  for (const date of tradingDates) candleRepo.rows.push(...normalSessionRows(date));
  const manifestService = new DatasetManifestService({
    historicalCandleRepository: candleRepo as unknown as HistoricalCandleRepository,
    historicalOptionCandleLakeRepository: new (class {
      async findRange(): Promise<PersistedManifestCandleRow[]> {
        return [];
      }
    })() as unknown as HistoricalOptionCandleLakeRepository,
    sessionBuilder: new DatasetSessionManifestBuilderService(),
    retrievalEvidenceService: NO_RETRIEVAL_EVIDENCE,
  });
  const manifest = await manifestService.generateUnderlyingManifest({ provider: HistoricalProviderId.UPSTOX, instrumentKey: INSTRUMENT_KEY, timeframe: '1minute', tradingDates });

  const exportService = new ResearchLakeParquetExportService({ historicalCandleRepository: candleRepo as unknown as HistoricalCandleRepository });
  const outputRoot = tempDir();
  const result = await exportService.exportDataset({ manifest, outputRoot });
  return { manifest, descriptor: result.descriptor!, outputRoot };
}

test('(verify) succeeds against an untouched, correctly exported storage descriptor', async () => {
  const { manifest, descriptor, outputRoot } = await buildAndExport(['2022-01-03']);
  try {
    const verifyService = new ResearchLakeParquetVerifyService();
    const result = await verifyService.verifyStorageDescriptor({ descriptor, manifest, storageRoot: outputRoot });

    assert.equal(result.verified, true);
    assert.equal(result.datasetLinkageMatches, true);
    assert.deepEqual(result.mismatchedTradingDates, []);
  } finally {
    rmSync(outputRoot, { recursive: true, force: true });
  }
});

test('(verify/O) physical file byte corruption is detected', async () => {
  const { manifest, descriptor, outputRoot } = await buildAndExport(['2022-01-03']);
  try {
    const filePath = join(outputRoot, descriptor.sessions[0].relativePath);
    const original = readFileSync(filePath);
    original[10] ^= 0xff; // flip a byte deep in the file body
    writeFileSync(filePath, original);

    const verifyService = new ResearchLakeParquetVerifyService();
    const result = await verifyService.verifyStorageDescriptor({ descriptor, manifest, storageRoot: outputRoot });

    assert.equal(result.verified, false);
    assert.equal(result.sessionResults[0].physicalChecksumMatches, false);
    assert.deepEqual(result.mismatchedTradingDates, ['2022-01-03']);
  } finally {
    rmSync(outputRoot, { recursive: true, force: true });
  }
});

test('(verify/P) valid Parquet bytes with a semantic mutation (physical checksum recomputed to match, content wrong) are detected by logical checksum', async () => {
  const { manifest, outputRoot } = await buildAndExport(['2022-01-03']);
  try {
    // Re-export a DIFFERENT session's content under the SAME descriptor entry (simulates a valid-but-wrong-content swap):
    // build a second, mutated dataset, then hand-craft a descriptor pointing at that mutated file while claiming the ORIGINAL checksum.
    const mutatedCandleRepo = new FakeHistoricalCandleRepository();
    mutatedCandleRepo.rows = normalSessionRows('2022-01-03').map((row, index) => (index === 0 ? { ...row, volume: 9_999n } : row)); // still valid OHLC/volume -- stays HEALTHY, only the content checksum differs
    const mutatedManifestService = new DatasetManifestService({
      historicalCandleRepository: mutatedCandleRepo as unknown as HistoricalCandleRepository,
      sessionBuilder: new DatasetSessionManifestBuilderService(),
      retrievalEvidenceService: NO_RETRIEVAL_EVIDENCE,
    });
    const mutatedManifest = await mutatedManifestService.generateUnderlyingManifest({ provider: HistoricalProviderId.UPSTOX, instrumentKey: INSTRUMENT_KEY, timeframe: '1minute', tradingDates: ['2022-01-03'] });
    const mutatedExportService = new ResearchLakeParquetExportService({ historicalCandleRepository: mutatedCandleRepo as unknown as HistoricalCandleRepository });
    const mutatedOutputRoot = tempDir();
    const mutatedResult = await mutatedExportService.exportDataset({ manifest: mutatedManifest, outputRoot: mutatedOutputRoot });

    // Craft a descriptor that claims the ORIGINAL session's checksum/rowcount but points at the MUTATED file's physical checksum -- this models "valid Parquet bytes, wrong logical content, physical checksum of the (wrong) bytes still matches the (wrong) descriptor entry".
    const forgedDescriptor: ParquetDatasetStorageDescriptor = {
      ...mutatedResult.descriptor!,
      datasetId: manifest.datasetId,
      datasetChecksum: manifest.datasetChecksum,
      sessions: [{ ...mutatedResult.descriptor!.sessions[0], sessionContentChecksum: manifest.sessions[0].contentChecksum }],
    };

    const verifyService = new ResearchLakeParquetVerifyService();
    const result = await verifyService.verifyStorageDescriptor({ descriptor: forgedDescriptor, manifest, storageRoot: mutatedOutputRoot });

    assert.equal(result.verified, false);
    assert.equal(result.sessionResults[0].physicalChecksumMatches, true); // bytes match what the (forged) descriptor claims
    assert.equal(result.sessionResults[0].parquetParsed, true);
    assert.equal(result.sessionResults[0].logicalContentChecksumMatches, false); // but the content is wrong
    rmSync(mutatedOutputRoot, { recursive: true, force: true });
  } finally {
    rmSync(outputRoot, { recursive: true, force: true });
  }
});

test('(verify/Q) a missing session file is detected', async () => {
  const { manifest, descriptor, outputRoot } = await buildAndExport(['2022-01-03']);
  try {
    unlinkSync(join(outputRoot, descriptor.sessions[0].relativePath));

    const verifyService = new ResearchLakeParquetVerifyService();
    const result = await verifyService.verifyStorageDescriptor({ descriptor, manifest, storageRoot: outputRoot });

    assert.equal(result.verified, false);
    assert.equal(result.sessionResults[0].physicalFileExists, false);
  } finally {
    rmSync(outputRoot, { recursive: true, force: true });
  }
});

test('(verify/R) an unsupported storage schema version is rejected fail-closed', async () => {
  const { manifest, descriptor, outputRoot } = await buildAndExport(['2022-01-03']);
  try {
    const badDescriptor: ParquetDatasetStorageDescriptor = { ...descriptor, storageSchemaVersion: 999 };
    const verifyService = new ResearchLakeParquetVerifyService();

    await assert.rejects(() => verifyService.verifyStorageDescriptor({ descriptor: badDescriptor, manifest, storageRoot: outputRoot }), /Unsupported B-F6 storage schema version/);
  } finally {
    rmSync(outputRoot, { recursive: true, force: true });
  }
});

test('(verify/T) a wrong datasetChecksum linkage between descriptor and manifest is rejected', async () => {
  const { manifest, descriptor, outputRoot } = await buildAndExport(['2022-01-03']);
  try {
    const badDescriptor: ParquetDatasetStorageDescriptor = { ...descriptor, datasetChecksum: 'f'.repeat(64) };
    const verifyService = new ResearchLakeParquetVerifyService();
    const result = await verifyService.verifyStorageDescriptor({ descriptor: badDescriptor, manifest, storageRoot: outputRoot });

    assert.equal(result.datasetLinkageMatches, false);
    assert.equal(result.verified, false);
  } finally {
    rmSync(outputRoot, { recursive: true, force: true });
  }
});

test('(verify/U) a wrong session contentChecksum linkage is rejected', async () => {
  const { manifest, descriptor, outputRoot } = await buildAndExport(['2022-01-03']);
  try {
    const badDescriptor: ParquetDatasetStorageDescriptor = { ...descriptor, sessions: [{ ...descriptor.sessions[0], sessionContentChecksum: 'b'.repeat(64) }] };
    const verifyService = new ResearchLakeParquetVerifyService();
    const result = await verifyService.verifyStorageDescriptor({ descriptor: badDescriptor, manifest, storageRoot: outputRoot });

    assert.equal(result.verified, false);
    assert.equal(result.sessionResults[0].logicalContentChecksumMatches, false);
  } finally {
    rmSync(outputRoot, { recursive: true, force: true });
  }
});

test('(verify/V) a duplicate session descriptor entry (same tradingDate twice) is rejected', async () => {
  const { manifest, descriptor, outputRoot } = await buildAndExport(['2022-01-03']);
  try {
    const badDescriptor: ParquetDatasetStorageDescriptor = { ...descriptor, sessions: [descriptor.sessions[0], descriptor.sessions[0]] };
    const verifyService = new ResearchLakeParquetVerifyService();

    await assert.rejects(() => verifyService.verifyStorageDescriptor({ descriptor: badDescriptor, manifest, storageRoot: outputRoot }), /Duplicate/);
  } finally {
    rmSync(outputRoot, { recursive: true, force: true });
  }
});

test('(verify/W) session verification ordering is deterministic regardless of descriptor entry order', async () => {
  const { manifest, descriptor, outputRoot } = await buildAndExport(['2022-01-03']);
  try {
    const verifyService = new ResearchLakeParquetVerifyService();
    const first = await verifyService.verifyStorageDescriptor({ descriptor, manifest, storageRoot: outputRoot });
    const reversed: ParquetDatasetStorageDescriptor = { ...descriptor, sessions: [...descriptor.sessions].reverse() };
    const second = await verifyService.verifyStorageDescriptor({ descriptor: reversed, manifest, storageRoot: outputRoot });

    assert.deepEqual(first.mismatchedTradingDates, second.mismatchedTradingDates);
    assert.equal(first.verified, second.verified);
  } finally {
    rmSync(outputRoot, { recursive: true, force: true });
  }
});

test('(verify) an orphaned descriptor session (no corresponding manifest session) is rejected', async () => {
  const { manifest, descriptor, outputRoot } = await buildAndExport(['2022-01-03']);
  try {
    const badDescriptor: ParquetDatasetStorageDescriptor = { ...descriptor, sessions: [{ ...descriptor.sessions[0], tradingDate: '2099-01-01' }] };
    const verifyService = new ResearchLakeParquetVerifyService();
    const result = await verifyService.verifyStorageDescriptor({ descriptor: badDescriptor, manifest, storageRoot: outputRoot });

    assert.equal(result.verified, false);
    assert.match(result.sessionResults[0].detail ?? '', /orphaned/i);
  } finally {
    rmSync(outputRoot, { recursive: true, force: true });
  }
});

// ============================================================================
// B-F2D CORRECTION (Terra re-review HIGH-1): "ResearchLakeParquetVerifyService
// .verifyStorageDescriptor() must defend itself as a real trust boundary" --
// these tests call `verifyStorageDescriptor` DIRECTLY with a manifest that
// was never validated by any upstream caller, and prove rejection happens
// BEFORE the descriptor's own semantic comparison, any filesystem read, or
// any checksum/session interpretation. `storageRoot` is deliberately deleted
// (or never created) before each malformed-manifest call so a filesystem
// read attempted before the guard would surface as an unrelated ENOENT-style
// failure rather than the guard's own error -- every assertion below expects
// the GUARD's error specifically.
// ============================================================================

/** Strips the v2-v5-only fields off a REAL, already-exported manifest to produce a genuinely v1-shaped artifact -- see the identical helper's doc in research-lake-parquet-export.service.test.ts. */
function downgradeToV1Shape(manifest: DatasetManifest): DatasetManifest {
  return {
    ...manifest,
    manifestSchemaVersion: 1,
    sessions: manifest.sessions.map((session) => {
      const { availability, providerRowCount, excludedRowCount, sourceOrderAnomalyCount, sourceHealthStatus } = session.sourceAcquisitionEvidence;
      const sessionWithoutCalendarWindows = { ...session } as Record<string, unknown>;
      delete sessionWithoutCalendarWindows.calendarSessionWindows;
      return { ...sessionWithoutCalendarWindows, sourceAcquisitionEvidence: { availability, providerRowCount, excludedRowCount, sourceOrderAnomalyCount, sourceHealthStatus } };
    }),
  } as unknown as DatasetManifest;
}

test('(verify TRUST BOUNDARY 1) a future (v6) manifest is rejected before any descriptor comparison or filesystem read', async () => {
  const { manifest, descriptor, outputRoot } = await buildAndExport(['2022-01-03']);
  rmSync(outputRoot, { recursive: true, force: true }); // storageRoot no longer exists -- a filesystem read reaching here would fail differently
  const future = { ...manifest, manifestSchemaVersion: manifest.manifestSchemaVersion + 1 };
  const verifyService = new ResearchLakeParquetVerifyService();
  await assert.rejects(() => verifyService.verifyStorageDescriptor({ descriptor, manifest: future, storageRoot: outputRoot }), /newer than this reader supports/);
});

test('(verify TRUST BOUNDARY 2) a v4 manifest carrying UNKNOWN_LEGACY_REPAIR_PROVENANCE (a v5-only value) is rejected before any descriptor comparison or filesystem read', async () => {
  const { manifest, descriptor, outputRoot } = await buildAndExport(['2022-01-03']);
  rmSync(outputRoot, { recursive: true, force: true });
  const invalidV4 = {
    ...manifest,
    manifestSchemaVersion: 4,
    sessions: manifest.sessions.map((session) => ({ ...session, sourceAcquisitionEvidence: { ...session.sourceAcquisitionEvidence, provenanceComposition: 'UNKNOWN_LEGACY_REPAIR_PROVENANCE' } })),
  } as unknown as DatasetManifest;
  const verifyService = new ResearchLakeParquetVerifyService();
  await assert.rejects(() => verifyService.verifyStorageDescriptor({ descriptor, manifest: invalidV4, storageRoot: outputRoot }), /provenanceComposition/);
});

test('(verify TRUST BOUNDARY 3) a malformed/non-integer manifestSchemaVersion is rejected before any descriptor comparison or filesystem read', async () => {
  const { manifest, descriptor, outputRoot } = await buildAndExport(['2022-01-03']);
  rmSync(outputRoot, { recursive: true, force: true });
  const malformed = { ...manifest, manifestSchemaVersion: '5' as unknown as number };
  const verifyService = new ResearchLakeParquetVerifyService();
  await assert.rejects(() => verifyService.verifyStorageDescriptor({ descriptor, manifest: malformed, storageRoot: outputRoot }), /valid integer manifestSchemaVersion/);
});

test('(verify TRUST BOUNDARY 4) an unknown/future provenanceComposition enum string is rejected before any descriptor comparison or filesystem read', async () => {
  const { manifest, descriptor, outputRoot } = await buildAndExport(['2022-01-03']);
  rmSync(outputRoot, { recursive: true, force: true });
  const unknownEnum = {
    ...manifest,
    sessions: manifest.sessions.map((session) => ({ ...session, sourceAcquisitionEvidence: { ...session.sourceAcquisitionEvidence, provenanceComposition: 'NOT_A_REAL_VALUE' } })),
  } as unknown as DatasetManifest;
  const verifyService = new ResearchLakeParquetVerifyService();
  await assert.rejects(() => verifyService.verifyStorageDescriptor({ descriptor, manifest: unknownEnum, storageRoot: outputRoot }), /provenanceComposition/);
});

test('(verify TRUST BOUNDARY 5) missing sessions field is rejected before any descriptor comparison or filesystem read', async () => {
  const { manifest, descriptor, outputRoot } = await buildAndExport(['2022-01-03']);
  rmSync(outputRoot, { recursive: true, force: true });
  const withoutSessions = { ...manifest } as Record<string, unknown>;
  delete withoutSessions.sessions;
  const verifyService = new ResearchLakeParquetVerifyService();
  await assert.rejects(() => verifyService.verifyStorageDescriptor({ descriptor, manifest: withoutSessions as unknown as DatasetManifest, storageRoot: outputRoot }), /sessions array/);
});

test('(verify TRUST BOUNDARY 6) a non-array sessions field is rejected before any descriptor comparison or filesystem read', async () => {
  const { manifest, descriptor, outputRoot } = await buildAndExport(['2022-01-03']);
  rmSync(outputRoot, { recursive: true, force: true });
  const nonArraySessions = { ...manifest, sessions: { not: 'an array' } } as unknown as DatasetManifest;
  const verifyService = new ResearchLakeParquetVerifyService();
  await assert.rejects(() => verifyService.verifyStorageDescriptor({ descriptor, manifest: nonArraySessions, storageRoot: outputRoot }), /sessions array/);
});

test('(verify TRUST BOUNDARY 7) a genuine v1-shaped historical manifest is accepted and verified normally', async () => {
  const { manifest, descriptor, outputRoot } = await buildAndExport(['2022-01-03']);
  try {
    const v1Manifest = downgradeToV1Shape(manifest);
    assert.equal((v1Manifest.sessions[0] as unknown as Record<string, unknown>).calendarSessionWindows, undefined, 'sanity check: the fixture must genuinely omit calendarSessionWindows');
    const verifyService = new ResearchLakeParquetVerifyService();
    const result = await verifyService.verifyStorageDescriptor({ descriptor, manifest: v1Manifest, storageRoot: outputRoot });
    assert.equal(result.verified, true);
    assert.equal(result.datasetLinkageMatches, true);
  } finally {
    rmSync(outputRoot, { recursive: true, force: true });
  }
});

test('(verify TRUST BOUNDARY 8) a valid current (v5) manifest is accepted and verified normally', async () => {
  const { manifest, descriptor, outputRoot } = await buildAndExport(['2022-01-03']);
  try {
    assert.equal(manifest.manifestSchemaVersion, MANIFEST_SCHEMA_VERSION);
    const verifyService = new ResearchLakeParquetVerifyService();
    const result = await verifyService.verifyStorageDescriptor({ descriptor, manifest, storageRoot: outputRoot });
    assert.equal(result.verified, true);
  } finally {
    rmSync(outputRoot, { recursive: true, force: true });
  }
});
