import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import manifestJson from '../domain/data/nse-2024-source-manifest.json';
import { runNse2024PilotArchive } from './nse-2024-pilot-archive-runner';
import { RawSourceDownloader } from './nse-raw-source-archiver.service';
import { RawSourceDownloadResult } from './nse-raw-source-downloader.service';
import { deriveExpectedRawSourceUrl } from '../domain/raw-source-manifest-url-binding';

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

/** Downloads every URL successfully with unique-per-reference bytes, EXCEPT references listed in `failReferences` (transport error) or `skipUrls` (never actually reachable here since the runner itself gates on manifest completeness before ever calling this). */
class ScriptedDownloader implements RawSourceDownloader {
  constructor(private readonly failUrls: ReadonlySet<string> = new Set()) {}
  async download(url: string): Promise<RawSourceDownloadResult> {
    if (this.failUrls.has(url)) throw new Error('Simulated transport failure for this URL.');
    return { requestedUrl: url, resolvedFinalUrl: url, httpStatus: 200, contentType: 'application/pdf', etag: null, lastModified: null, bytes: validSyntheticPdfBytes(url) };
  }
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
