import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runReviewedRawSourceArchive } from './reviewed-raw-source-archive-runner';
import { RawSourceDownloader } from './nse-raw-source-archiver.service';
import { RawSourceDownloadResult } from './nse-raw-source-downloader.service';
import { deriveExpectedRawSourceUrl } from '../domain/raw-source-manifest-url-binding';
import { RAW_SOURCE_MANIFEST_SCHEMA_VERSION } from '../domain/raw-source-archive.types';

function tempArchiveRoot(): string {
  return mkdtempSync(join(tmpdir(), 'reviewed-raw-source-archive-runner-test-'));
}

function validSyntheticPdfBytes(marker: string): Buffer {
  const header = '%PDF-1.4\n';
  const body = `%synthetic generic-runner test content for ${marker}\n`.repeat(4);
  const trailer = '\n%%EOF\n';
  return Buffer.from(header + body + trailer, 'ascii');
}

class ScriptedDownloader implements RawSourceDownloader {
  constructor(private readonly failUrls: ReadonlySet<string> = new Set()) {}
  async download(url: string): Promise<RawSourceDownloadResult> {
    if (this.failUrls.has(url)) throw new Error('Simulated transport failure for this URL.');
    return { requestedUrl: url, resolvedFinalUrl: url, httpStatus: 200, contentType: 'application/pdf', etag: null, lastModified: null, rawBytes: validSyntheticPdfBytes(url), document: null };
  }
}

/** A minimal, independently-built two-entry reviewed manifest -- exercises the GENERIC runner without depending on the 2024-pilot-specific fixture data. */
const SYNTHETIC_2022_MANIFEST = {
  manifestSchemaVersion: RAW_SOURCE_MANIFEST_SCHEMA_VERSION,
  pilotId: 'B-F7A-SOURCE-EVIDENCE-1-2022-EQUITY-TEST',
  calendarYear: 2022,
  entries: [
    {
      reference: 'NSE/CMTR/50560',
      urlReviewStatus: 'REVIEWED',
      sourceUrl: 'https://nsearchives.nseindia.com/content/circulars/CMTR50560.pdf',
      primaryDepartment: 'Capital Market',
      circularReference: '117/2021',
      publicationDate: '2021-12-10',
      subject: 'Trading holidays for the calendar year 2022',
      applicableSegments: [{ domain: 'EQUITY', basis: 'DIRECT' }],
      sourceRole: 'ANNUAL_HOLIDAY_CIRCULAR',
      lifecycleStatus: 'FINAL',
      withdraws: [],
      withdrawnBy: null,
      supersedes: [],
      supersededBy: null,
      notes: null,
    },
    {
      reference: 'NSE/CMTR/54023',
      urlReviewStatus: 'REVIEWED',
      sourceUrl: 'https://nsearchives.nseindia.com/content/circulars/CMTR54023.pdf',
      primaryDepartment: 'Capital Market',
      circularReference: '124/2022',
      publicationDate: '2022-10-11',
      subject: 'Muhurat Trading session on account of Diwali',
      applicableSegments: [{ domain: 'EQUITY', basis: 'DIRECT' }],
      sourceRole: 'MUHURAT_TRADING_NOTICE',
      lifecycleStatus: 'FINAL',
      withdraws: [],
      withdrawnBy: null,
      supersedes: [],
      supersededBy: null,
      notes: null,
    },
  ],
};
const EXPECTED_2022_REFERENCES = ['NSE/CMTR/50560', 'NSE/CMTR/54023'];

test('a fully successful run over an arbitrary (non-2024) expected reference set reports success', async () => {
  const root = tempArchiveRoot();
  try {
    const outcome = await runReviewedRawSourceArchive({
      manifest: SYNTHETIC_2022_MANIFEST,
      expectedReferences: EXPECTED_2022_REFERENCES,
      label: '2022 EQUITY manifest',
      downloader: new ScriptedDownloader(),
      archiveRoot: root,
    });
    assert.equal(outcome.success, true);
    assert.equal(outcome.runResult.archivedCount, 2);
    assert.equal(outcome.runResult.failedCount, 0);
    assert.deepEqual(outcome.incompleteReferences, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a run with one failure reports failure and lists the incomplete reference', async () => {
  const root = tempArchiveRoot();
  try {
    const failingUrl = deriveExpectedRawSourceUrl('NSE/CMTR/54023');
    const outcome = await runReviewedRawSourceArchive({
      manifest: SYNTHETIC_2022_MANIFEST,
      expectedReferences: EXPECTED_2022_REFERENCES,
      label: '2022 EQUITY manifest',
      downloader: new ScriptedDownloader(new Set([failingUrl])),
      archiveRoot: root,
    });
    assert.equal(outcome.success, false);
    assert.deepEqual(outcome.incompleteReferences, ['NSE/CMTR/54023']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a manifest missing an expected reference is rejected before any archiving is attempted', async () => {
  const root = tempArchiveRoot();
  try {
    const incomplete = { ...SYNTHETIC_2022_MANIFEST, entries: SYNTHETIC_2022_MANIFEST.entries.slice(0, 1) };
    const downloader = new ScriptedDownloader();
    await assert.rejects(() =>
      runReviewedRawSourceArchive({ manifest: incomplete, expectedReferences: EXPECTED_2022_REFERENCES, label: '2022 EQUITY manifest', downloader, archiveRoot: root })
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('re-running a fully successful archive a second time is idempotent', async () => {
  const root = tempArchiveRoot();
  try {
    const first = await runReviewedRawSourceArchive({
      manifest: SYNTHETIC_2022_MANIFEST,
      expectedReferences: EXPECTED_2022_REFERENCES,
      label: '2022 EQUITY manifest',
      downloader: new ScriptedDownloader(),
      archiveRoot: root,
    });
    assert.equal(first.success, true);

    const second = await runReviewedRawSourceArchive({
      manifest: SYNTHETIC_2022_MANIFEST,
      expectedReferences: EXPECTED_2022_REFERENCES,
      label: '2022 EQUITY manifest',
      downloader: new ScriptedDownloader(),
      archiveRoot: root,
    });
    assert.equal(second.success, true);
    assert.ok(second.runResult.entries.every((entry) => entry.status === 'VERIFIED_IDEMPOTENT_EXISTING'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
