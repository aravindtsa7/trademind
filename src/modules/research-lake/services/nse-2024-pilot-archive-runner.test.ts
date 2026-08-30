import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';
import { PDFDocument } from 'pdf-lib';
import manifestJson from '../domain/data/nse-2024-source-manifest.json';
import { runNse2024PilotArchive } from './nse-2024-pilot-archive-runner';
import { RawSourceDownloader } from './nse-raw-source-archiver.service';
import NseRawSourceHttpDownloaderService, { RawSourceDownloadResult, RawSourceHttpRequestConfig, RawSourceHttpResponse, RawSourceHttpTransport } from './nse-raw-source-downloader.service';
import { deriveExpectedRawSourceUrl } from '../domain/raw-source-manifest-url-binding';
import { deriveExpectedZipMemberBasename } from '../domain/raw-source-zip-envelope.util';

function tempArchiveRoot(): string {
  return mkdtempSync(join(tmpdir(), 'raw-source-pilot-runner-test-'));
}

/** Structurally valid synthetic PDF, unique per reference so each entry gets a distinguishable hash. */
function validSyntheticPdfBytes(marker: string): Buffer {
  const header = '%PDF-1.4\n';
  const body = `%synthetic pilot-runner test content for ${marker}\n`.repeat(4);
  const trailer = '\n%%EOF\n';
  return Buffer.from(header + body + trailer, 'ascii');
}

/**
 * Downloads every URL successfully with unique-per-reference bytes, EXCEPT
 * references listed in `failReferences` (transport error) or `skipUrls`
 * (never actually reachable here since the runner itself gates on manifest
 * completeness before ever calling this). This double sits at the
 * ARCHIVER's own injection seam (`RawSourceDownloader`), bypassing the real
 * downloader's ZIP-DETECTION logic -- but it still returns a plausible
 * `document` layer for a `.zip`-suffixed URL (matching what the accepted
 * manifest declares for NSE/CMTR/60338), so its OUTPUT SHAPE is never
 * mistaken for the legacy pre-fix bug shape (no document evidence + a .zip
 * URL) on a second, idempotent run. It exercises archiver-level plumbing
 * (reconciliation/storage/idempotency/proposed-mapping), never the real ZIP
 * transport/extraction path itself (see the separate real-downloader
 * integration test below for that).
 */
class ScriptedDownloader implements RawSourceDownloader {
  constructor(private readonly failUrls: ReadonlySet<string> = new Set()) {}
  async download(url: string): Promise<RawSourceDownloadResult> {
    if (this.failUrls.has(url)) throw new Error('Simulated transport failure for this URL.');
    const rawBytes = validSyntheticPdfBytes(url);
    if (url.endsWith('.zip')) {
      const documentBytes = Buffer.concat([rawBytes, Buffer.from('-extracted-document', 'ascii')]);
      return {
        requestedUrl: url,
        resolvedFinalUrl: url,
        httpStatus: 200,
        contentType: 'application/zip',
        etag: null,
        lastModified: null,
        rawBytes,
        document: { bytes: documentBytes, memberName: 'synthetic.pdf', mediaType: 'application/pdf' },
      };
    }
    return { requestedUrl: url, resolvedFinalUrl: url, httpStatus: 200, contentType: 'application/pdf', etag: null, lastModified: null, rawBytes, document: null };
  }
}

/** A minimal single-entry ZIP wrapping `content` under `memberName` -- hand-assembled independently of `extractZipMember`, matching the convention in `raw-source-zip-envelope.util.test.ts`. */
function buildSingleEntryZip(memberName: string, content: Buffer): Buffer {
  const nameBytes = Buffer.from(memberName, 'utf8');
  const data = deflateRawSync(content);
  const entryCrc32 = crc32(content) >>> 0;

  const localHeader = Buffer.alloc(30);
  localHeader.writeUInt32LE(0x04034b50, 0);
  localHeader.writeUInt16LE(20, 4);
  localHeader.writeUInt16LE(0, 6);
  localHeader.writeUInt16LE(8, 8);
  localHeader.writeUInt16LE(0, 10);
  localHeader.writeUInt16LE(0, 12);
  localHeader.writeUInt32LE(entryCrc32, 14);
  localHeader.writeUInt32LE(data.length, 18);
  localHeader.writeUInt32LE(content.length, 22);
  localHeader.writeUInt16LE(nameBytes.length, 26);
  localHeader.writeUInt16LE(0, 28);
  const localSection = Buffer.concat([localHeader, nameBytes, data]);

  const centralHeader = Buffer.alloc(46);
  centralHeader.writeUInt32LE(0x02014b50, 0);
  centralHeader.writeUInt16LE(20, 4);
  centralHeader.writeUInt16LE(20, 6);
  centralHeader.writeUInt16LE(0, 8);
  centralHeader.writeUInt16LE(8, 10);
  centralHeader.writeUInt16LE(0, 12);
  centralHeader.writeUInt16LE(0, 14);
  centralHeader.writeUInt32LE(entryCrc32, 16);
  centralHeader.writeUInt32LE(data.length, 20);
  centralHeader.writeUInt32LE(content.length, 24);
  centralHeader.writeUInt16LE(nameBytes.length, 28);
  centralHeader.writeUInt16LE(0, 30);
  centralHeader.writeUInt16LE(0, 32);
  centralHeader.writeUInt16LE(0, 34);
  centralHeader.writeUInt16LE(0, 36);
  centralHeader.writeUInt32LE(0, 38);
  centralHeader.writeUInt32LE(0, 42);
  const centralSection = Buffer.concat([centralHeader, nameBytes]);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(centralSection.length, 12);
  eocd.writeUInt32LE(localSection.length, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([localSection, centralSection, eocd]);
}

test('(13) a fully successful 16/16 run reports success and returns a non-null proposed mapping', async () => {
  const root = tempArchiveRoot();
  try {
    const outcome = await runNse2024PilotArchive({ manifest: manifestJson, downloader: new ScriptedDownloader(), archiveRoot: root });
    assert.equal(outcome.success, true);
    assert.equal(outcome.runResult.archivedCount, 16);
    assert.equal(outcome.runResult.failedCount, 0);
    assert.deepEqual(outcome.incompleteReferences, []);
    assert.ok(outcome.proposedMapping !== null);
    assert.equal(outcome.proposedMapping!.proposalStatus, 'PROPOSAL_NOT_FOR_IMPORT');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('(13) a run with even one failure reports failure and NEVER returns a proposed mapping', async () => {
  const root = tempArchiveRoot();
  try {
    const failingUrl = deriveExpectedRawSourceUrl('NSE/MSD/60340');
    const outcome = await runNse2024PilotArchive({ manifest: manifestJson, downloader: new ScriptedDownloader(new Set([failingUrl])), archiveRoot: root });
    assert.equal(outcome.success, false);
    assert.equal(outcome.runResult.failedCount, 1);
    assert.deepEqual(outcome.incompleteReferences, ['NSE/MSD/60340']);
    assert.equal(outcome.proposedMapping, null, 'a partial run must never emit the proposed DRAFT mapping');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a manifest that has not been reviewed to completion (a PENDING entry) is rejected BEFORE any archiving is attempted', async () => {
  const root = tempArchiveRoot();
  try {
    const incomplete = {
      ...manifestJson,
      entries: manifestJson.entries.map((entry) => (entry.reference === 'NSE/MSD/60340' ? { ...entry, urlReviewStatus: 'PENDING_OFFICIAL_URL_ASSIGNMENT', sourceUrl: null } : entry)),
    };
    const downloader = new ScriptedDownloader();
    await assert.rejects(() => runNse2024PilotArchive({ manifest: incomplete, downloader, archiveRoot: root }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('re-running a fully successful pilot a second time is idempotent and still reports success with a proposed mapping', async () => {
  const root = tempArchiveRoot();
  try {
    const downloader = new ScriptedDownloader();
    const first = await runNse2024PilotArchive({ manifest: manifestJson, downloader, archiveRoot: root });
    assert.equal(first.success, true);

    const second = await runNse2024PilotArchive({ manifest: manifestJson, downloader: new ScriptedDownloader(), archiveRoot: root });
    assert.equal(second.success, true);
    assert.ok(second.runResult.entries.every((entry) => entry.status === 'VERIFIED_IDEMPOTENT_EXISTING'));
    assert.ok(second.proposedMapping !== null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ============================================================
// B-F7A-SOURCE-EVIDENCE-FIX-1 task section 19/20: the accepted 2024 pilot
// manifest's NSE/CMTR/60338 URL was corrected to its real official .zip
// form (Terra Defect D). This exercises the REAL production downloader
// (`NseRawSourceHttpDownloaderService`, with only its HTTP transport
// faked) through the SAME shared archiver path the pilot uses -- never a
// downloader-interface-level fake that would bypass the ZIP-unwrap logic
// entirely (task section 20: "Do not use only a fake downloader that
// bypasses ZIP transport logic.").
// ============================================================

class FakeHttpTransport implements RawSourceHttpTransport {
  constructor(private readonly responsesByUrl: ReadonlyMap<string, RawSourceHttpResponse>) {}
  async get(url: string, _config: RawSourceHttpRequestConfig): Promise<RawSourceHttpResponse> {
    const response = this.responsesByUrl.get(url);
    if (!response) throw new Error(`FakeHttpTransport: no response configured for ${url}`);
    return response;
  }
}

async function validPdfBytesForPilot(marker: string): Promise<Buffer> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  doc.addPage([200, 200]);
  const bytes = Buffer.from(await doc.save());
  return Buffer.concat([bytes, Buffer.from(`\n%marker:${marker}\n`, 'ascii')]);
}

test('(19/20) the full 16-document pilot, run through the REAL downloader with only HTTP transport faked, correctly unwraps the corrected NSE/CMTR/60338 .zip URL end to end', async () => {
  const root = tempArchiveRoot();
  try {
    const zipEntry = manifestJson.entries.find((entry) => entry.reference === 'NSE/CMTR/60338')!;
    assert.ok(zipEntry.sourceUrl!.endsWith('.zip'), 'test precondition: the accepted manifest must declare the corrected .zip URL for NSE/CMTR/60338');

    const responsesByUrl = new Map<string, RawSourceHttpResponse>();
    for (const entry of manifestJson.entries) {
      const url = entry.sourceUrl!;
      if (url === zipEntry.sourceUrl) {
        const pdfBytes = await validPdfBytesForPilot(entry.reference);
        const zipMemberName = deriveExpectedZipMemberBasename(url);
        const zipBytes = buildSingleEntryZip(zipMemberName, pdfBytes);
        responsesByUrl.set(url, { status: 200, data: zipBytes, headers: { 'content-type': 'application/zip' } });
      } else {
        responsesByUrl.set(url, { status: 200, data: await validPdfBytesForPilot(entry.reference), headers: { 'content-type': 'application/pdf' } });
      }
    }

    const realDownloader = new NseRawSourceHttpDownloaderService(new FakeHttpTransport(responsesByUrl));
    const outcome = await runNse2024PilotArchive({ manifest: manifestJson, downloader: realDownloader, archiveRoot: root });

    assert.equal(outcome.success, true, JSON.stringify(outcome.runResult.entries.filter((e) => e.status !== 'ARCHIVED_NEW')));
    assert.equal(outcome.runResult.archivedCount, 16);

    const zipResult = outcome.runResult.entries.find((e) => e.reference === 'NSE/CMTR/60338')!;
    assert.ok(zipResult.receipt!.archiveRelativePath.endsWith('.zip'), 'the raw/transport blob for a ZIP-wrapped source must be stored with a .zip extension');
    assert.ok(zipResult.receipt!.documentEvidence !== null, 'a ZIP-wrapped source must carry document-layer evidence');
    assert.ok(zipResult.receipt!.documentEvidence!.documentArchiveRelativePath.endsWith('.pdf'));
    assert.notEqual(zipResult.receipt!.rawSha256, zipResult.receipt!.documentEvidence!.documentSha256, 'transport (zip) and document (pdf) hashes must genuinely differ');

    const directResult = outcome.runResult.entries.find((e) => e.reference === 'NSE/CMTR/59722')!;
    assert.equal(directResult.receipt!.documentEvidence, null, 'a direct-PDF source carries no separate document layer');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
