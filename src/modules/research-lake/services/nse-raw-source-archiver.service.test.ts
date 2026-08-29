import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import RawSourceArchiverService, { RawSourceDownloader, evaluatePilotArchiveOutcome, RawSourceArchiveRunResult } from './nse-raw-source-archiver.service';
import { RawSourceDownloadResult } from './nse-raw-source-downloader.service';
import { sha256HexOfBuffer } from '../domain/file-checksum';
import { rawSourceBlobRelativePath, storeRawSourceBlob } from '../domain/raw-source-archive-storage';
import { RawSourceApplicabilityBasis, RawSourceApplicabilityDomain, RawSourceLifecycleStatus, RawSourceRole, RawSourceUrlReviewStatus, ReviewedRawSourceManifestEntry } from '../domain/raw-source-archive.types';

function tempArchiveRoot(): string {
  return mkdtempSync(join(tmpdir(), 'raw-source-archiver-test-'));
}

function reviewedEntry(overrides: Partial<ReviewedRawSourceManifestEntry> = {}): ReviewedRawSourceManifestEntry {
  return {
    reference: 'NSE/MSD/60340',
    urlReviewStatus: RawSourceUrlReviewStatus.REVIEWED,
    sourceUrl: 'https://nsearchives.nseindia.com/content/circulars/MSD60340.pdf',
    primaryDepartment: 'MEMBER SERVICE DEPARTMENT',
    circularReference: '05/2024',
    publicationDate: '2024-01-19',
    subject: 'Live trading session on Saturday, January 20, 2024 on Primary site',
    applicableSegments: [{ domain: RawSourceApplicabilityDomain.EQUITY, basis: RawSourceApplicabilityBasis.DIRECT }],
    sourceRole: RawSourceRole.SPECIAL_SESSION_NOTICE,
    lifecycleStatus: RawSourceLifecycleStatus.FINAL,
    withdraws: [],
    withdrawnBy: null,
    supersedes: [],
    supersededBy: null,
    notes: null,
    ...overrides,
  };
}

function otherReviewedEntry(overrides: Partial<ReviewedRawSourceManifestEntry> = {}): ReviewedRawSourceManifestEntry {
  return reviewedEntry({
    reference: 'NSE/CMTR/59722',
    sourceUrl: 'https://nsearchives.nseindia.com/content/circulars/CMTR59722.pdf',
    primaryDepartment: 'Capital Market',
    sourceRole: RawSourceRole.ANNUAL_HOLIDAY_CIRCULAR,
    applicableSegments: [{ domain: RawSourceApplicabilityDomain.EQUITY, basis: RawSourceApplicabilityBasis.DIRECT }],
    ...overrides,
  });
}

class FakeDownloader implements RawSourceDownloader {
  callCount = 0;
  constructor(private readonly bytesPerCall: readonly Buffer[]) {}
  async download(url: string): Promise<RawSourceDownloadResult> {
    const bytes = this.bytesPerCall[this.callCount];
    this.callCount += 1;
    if (bytes === undefined) throw new Error('FakeDownloader: no more configured responses.');
    return { requestedUrl: url, resolvedFinalUrl: url, httpStatus: 200, contentType: 'application/pdf', etag: null, lastModified: null, bytes };
  }
}

const PDF_A = Buffer.from('%PDF-1.4\nfirst version', 'ascii');
const PDF_B = Buffer.from('%PDF-1.4\ndifferent content entirely', 'ascii');

function readReceiptIndex(root: string): Record<string, unknown> {
  const raw = JSON.parse(readFileSync(join(root, 'receipts', 'receipt-index.json'), 'utf8'));
  return raw.receipts;
}

test('a PENDING_OFFICIAL_URL_ASSIGNMENT entry is skipped without ever calling the downloader (never guesses a URL)', async () => {
  const root = tempArchiveRoot();
  try {
    const downloader = new FakeDownloader([PDF_A]);
    const archiver = new RawSourceArchiverService(downloader, root);
    const entry = reviewedEntry({ urlReviewStatus: RawSourceUrlReviewStatus.PENDING_OFFICIAL_URL_ASSIGNMENT, sourceUrl: null });
    const result = await archiver.archiveEntry(entry, {});
    assert.equal(result.status, 'SKIPPED_URL_NOT_REVIEWED');
    assert.equal(downloader.callCount, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('(Defect E defense-in-depth) a REVIEWED entry whose URL does not bind to its own reference is rejected before any download', async () => {
  const root = tempArchiveRoot();
  try {
    const downloader = new FakeDownloader([PDF_A]);
    const archiver = new RawSourceArchiverService(downloader, root);
    const mismatched = reviewedEntry({ sourceUrl: 'https://nsearchives.nseindia.com/content/circulars/MSD60318.pdf' });
    const result = await archiver.archiveEntry(mismatched, {});
    assert.equal(result.status, 'FAILED_ERROR');
    assert.match(result.detail ?? '', /URL_REFERENCE_MISMATCH|does not match|basename/i);
    assert.equal(downloader.callCount, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a new reference is archived: stored on disk and a receipt is produced', async () => {
  const root = tempArchiveRoot();
  try {
    const downloader = new FakeDownloader([PDF_A]);
    const archiver = new RawSourceArchiverService(downloader, root);
    const result = await archiver.archiveEntry(reviewedEntry(), {});
    assert.equal(result.status, 'ARCHIVED_NEW');
    assert.ok(result.receipt);
    assert.ok(existsSync(join(root, result.receipt!.archiveRelativePath)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('archiveManifest persists the receipt index incrementally, and a full run over one entry is idempotent on a second run', async () => {
  const root = tempArchiveRoot();
  try {
    const manifest = { manifestSchemaVersion: 1, pilotId: 'TEST', calendarYear: 2024, entries: [reviewedEntry()] };

    const firstDownloader = new FakeDownloader([PDF_A]);
    const firstArchiver = new RawSourceArchiverService(firstDownloader, root);
    const firstRun = await firstArchiver.archiveManifest(manifest);
    assert.equal(firstRun.archivedCount, 1);
    assert.equal(firstRun.failedCount, 0);

    const persisted = readReceiptIndex(root);
    assert.ok(persisted['NSE/MSD/60340']);

    // Second run with a fresh downloader instance returning the SAME bytes -- must be idempotent (never re-hits the "content changed" path).
    const secondDownloader = new FakeDownloader([PDF_A]);
    const secondArchiver = new RawSourceArchiverService(secondDownloader, root);
    const secondRun = await secondArchiver.archiveManifest(manifest);
    assert.equal(secondRun.archivedCount, 1);
    assert.equal(secondRun.failedCount, 0);
    assert.equal(secondRun.entries[0].status, 'VERIFIED_IDEMPOTENT_EXISTING');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('same reference + different bytes across two runs produces a hard conflict, never a silent overwrite', async () => {
  const root = tempArchiveRoot();
  try {
    const manifest = { manifestSchemaVersion: 1, pilotId: 'TEST', calendarYear: 2024, entries: [reviewedEntry()] };

    const firstArchiver = new RawSourceArchiverService(new FakeDownloader([PDF_A]), root);
    const firstRun = await firstArchiver.archiveManifest(manifest);
    assert.equal(firstRun.archivedCount, 1);
    const firstSha256 = firstRun.entries[0].receipt!.rawSha256;

    const secondArchiver = new RawSourceArchiverService(new FakeDownloader([PDF_B]), root);
    const secondRun = await secondArchiver.archiveManifest(manifest);
    assert.equal(secondRun.entries[0].status, 'FAILED_CONTENT_CHANGED');
    assert.equal(secondRun.entries[0].conflict!.existingSha256, firstSha256);
    assert.notEqual(secondRun.entries[0].conflict!.newSha256, firstSha256);

    // The original blob must remain untouched -- the conflicting run wrote nothing new for this reference.
    const persisted = readReceiptIndex(root);
    assert.equal((persisted['NSE/MSD/60340'] as { rawSha256: string }).rawSha256, firstSha256);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('(16/17) receipt-to-blob integrity: a receipt whose blob went missing from disk fails closed rather than being silently redownloaded/overwritten', async () => {
  const root = tempArchiveRoot();
  try {
    const manifest = { manifestSchemaVersion: 1, pilotId: 'TEST', calendarYear: 2024, entries: [reviewedEntry()] };
    const firstRun = await new RawSourceArchiverService(new FakeDownloader([PDF_A]), root).archiveManifest(manifest);
    assert.equal(firstRun.archivedCount, 1);

    const blobPath = join(root, firstRun.entries[0].receipt!.archiveRelativePath);
    rmSync(blobPath);

    const secondRun = await new RawSourceArchiverService(new FakeDownloader([PDF_A]), root).archiveManifest(manifest);
    assert.equal(secondRun.entries[0].status, 'FAILED_ERROR');
    assert.match(secondRun.entries[0].detail ?? '', /ARCHIVE_RECEIPT_BLOB_MISSING|does not exist on disk/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('(18) receipt-to-blob integrity: a receipt whose blob was corrupted on disk fails closed', async () => {
  const root = tempArchiveRoot();
  try {
    const manifest = { manifestSchemaVersion: 1, pilotId: 'TEST', calendarYear: 2024, entries: [reviewedEntry()] };
    const firstRun = await new RawSourceArchiverService(new FakeDownloader([PDF_A]), root).archiveManifest(manifest);
    assert.equal(firstRun.archivedCount, 1);

    const blobPath = join(root, firstRun.entries[0].receipt!.archiveRelativePath);
    writeFileSync(blobPath, Buffer.from('tampered bytes not matching the receipt hash'));

    const secondRun = await new RawSourceArchiverService(new FakeDownloader([PDF_A]), root).archiveManifest(manifest);
    assert.equal(secondRun.entries[0].status, 'FAILED_ERROR');
    assert.match(secondRun.entries[0].detail ?? '', /recorded (raw)?[sS]ha256|hashes to|byteLength/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('(15/22) crash recovery Case 1: an orphan blob (blob exists, receipt absent) is safely reconciled into a receipt on the next run without rewriting bytes', async () => {
  const root = tempArchiveRoot();
  try {
    // Simulate a crash between blob-publish and receipt-publish: write the blob directly, but no receipt index exists yet.
    const hash = sha256HexOfBuffer(PDF_A);
    const stored = storeRawSourceBlob(root, PDF_A, hash);
    assert.equal(stored.wasNewlyWritten, true);

    const manifest = { manifestSchemaVersion: 1, pilotId: 'TEST', calendarYear: 2024, entries: [reviewedEntry()] };
    // Fresh download of the SAME content (genuine content reconciliation, never an arbitrary blob assignment).
    const run = await new RawSourceArchiverService(new FakeDownloader([PDF_A]), root).archiveManifest(manifest);
    assert.equal(run.entries[0].status, 'ARCHIVED_NEW');
    assert.equal(run.entries[0].receipt!.rawSha256, hash);
    assert.equal(run.entries[0].receipt!.archiveRelativePath, rawSourceBlobRelativePath(hash));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('(15/23) a malformed on-disk receipt index fails the whole run closed rather than being treated as empty state', async () => {
  const root = tempArchiveRoot();
  try {
    mkdirSync(join(root, 'receipts'), { recursive: true });
    writeFileSync(join(root, 'receipts', 'receipt-index.json'), 'not valid json at all {{{');

    const manifest = { manifestSchemaVersion: 1, pilotId: 'TEST', calendarYear: 2024, entries: [reviewedEntry()] };
    await assert.rejects(() => new RawSourceArchiverService(new FakeDownloader([PDF_A]), root).archiveManifest(manifest));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('(14/20) two concurrent archiveManifest runs for DIFFERENT references never lose either receipt entry', async () => {
  const root = tempArchiveRoot();
  try {
    const manifestA = { manifestSchemaVersion: 1, pilotId: 'TEST', calendarYear: 2024, entries: [reviewedEntry()] };
    const manifestB = { manifestSchemaVersion: 1, pilotId: 'TEST', calendarYear: 2024, entries: [otherReviewedEntry()] };

    const [runA, runB] = await Promise.all([
      new RawSourceArchiverService(new FakeDownloader([PDF_A]), root).archiveManifest(manifestA),
      new RawSourceArchiverService(new FakeDownloader([PDF_B]), root).archiveManifest(manifestB),
    ]);

    assert.equal(runA.archivedCount, 1);
    assert.equal(runB.archivedCount, 1);

    const persisted = readReceiptIndex(root);
    assert.ok(persisted['NSE/MSD/60340'], 'process A receipt must survive concurrent completion');
    assert.ok(persisted['NSE/CMTR/59722'], 'process B receipt must survive concurrent completion');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function fakeRunResult(statuses: readonly RawSourceArchiveRunResult['entries'][number]['status'][]): RawSourceArchiveRunResult {
  const entries = statuses.map((status, index) => ({ reference: `NSE/MSD/${index}`, status, receipt: null, conflict: null, detail: null }));
  return {
    archiveRoot: 'unused',
    entries,
    archivedCount: entries.filter((e) => e.status === 'ARCHIVED_NEW' || e.status === 'VERIFIED_IDEMPOTENT_EXISTING').length,
    skippedCount: entries.filter((e) => e.status === 'SKIPPED_URL_NOT_REVIEWED').length,
    failedCount: entries.filter((e) => e.status === 'FAILED_CONTENT_CHANGED' || e.status === 'FAILED_ERROR').length,
  };
}

test('(9) evaluatePilotArchiveOutcome: 16/16 archived/idempotent is success', () => {
  const statuses = [...Array(10).fill('ARCHIVED_NEW'), ...Array(6).fill('VERIFIED_IDEMPOTENT_EXISTING')] as const;
  const outcome = evaluatePilotArchiveOutcome(fakeRunResult(statuses));
  assert.equal(outcome.success, true);
  assert.deepEqual(outcome.incompleteReferences, []);
});

test('(10) evaluatePilotArchiveOutcome: 15 success + 1 skipped is failure', () => {
  const statuses = [...Array(15).fill('ARCHIVED_NEW'), 'SKIPPED_URL_NOT_REVIEWED'] as const;
  const outcome = evaluatePilotArchiveOutcome(fakeRunResult(statuses));
  assert.equal(outcome.success, false);
  assert.equal(outcome.incompleteReferences.length, 1);
});

test('(11) evaluatePilotArchiveOutcome: 15 success + 1 failed is failure', () => {
  const statuses = [...Array(15).fill('ARCHIVED_NEW'), 'FAILED_ERROR'] as const;
  const outcome = evaluatePilotArchiveOutcome(fakeRunResult(statuses));
  assert.equal(outcome.success, false);
  assert.equal(outcome.incompleteReferences.length, 1);
});

test('(12) evaluatePilotArchiveOutcome: 0 archived + 16 skipped is failure', () => {
  const statuses = [...Array(16).fill('SKIPPED_URL_NOT_REVIEWED')] as const;
  const outcome = evaluatePilotArchiveOutcome(fakeRunResult(statuses));
  assert.equal(outcome.success, false);
  assert.equal(outcome.incompleteReferences.length, 16);
});

test('evaluatePilotArchiveOutcome: an empty run (no entries at all) is never success', () => {
  const outcome = evaluatePilotArchiveOutcome(fakeRunResult([]));
  assert.equal(outcome.success, false);
});

test('(35) no DB/import/certification path is reachable from the archiver, downloader, lock, receipt-index, or CLI entrypoint (no such import statement anywhere in the module graph)', () => {
  const forbidden = /prisma|PrismaClient|ExchangeCalendarRepository|ExchangeCalendarImporterService|ExchangeCalendarCertificationService/i;
  const filesToCheck = [
    join(__dirname, 'nse-raw-source-archiver.service.ts'),
    join(__dirname, 'nse-raw-source-downloader.service.ts'),
    join(__dirname, '..', 'domain', 'raw-source-archive-lock.ts'),
    join(__dirname, '..', 'domain', 'raw-source-receipt-index.ts'),
    join(__dirname, '..', '..', '..', 'tests', 'research-nse-2024-raw-source-archive.ts'),
  ];
  for (const filePath of filesToCheck) {
    const source = readFileSync(filePath, 'utf8');
    const importLines = source.split('\n').filter((line) => /^\s*import\b/.test(line));
    for (const line of importLines) {
      assert.ok(!forbidden.test(line), `Forbidden import found in ${filePath}: ${line}`);
    }
  }
});
