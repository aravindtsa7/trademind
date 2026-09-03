import { join } from 'path';
import { fileExists, readFileBuffer, writeBufferAtomic } from './atomic-file-writer';
import { DatasetManifest, ManifestDatasetKind, computeDatasetChecksum } from './dataset-manifest.types';
import { assertManifestSchemaCompatible } from './manifest-schema-compatibility.util';

/**
 * B-M8A: a narrow validate-before-write wrapper around the existing B-F5
 * canonical `DatasetManifest` artifact shape/path convention (task: "Do NOT
 * invent a second canonical-manifest schema... Prefer repository-native path
 * convention"). The existing generic writer
 * (`src/tests/research-dataset-manifest-generate.ts`) always blindly
 * `writeFile`s at this same `{datasetKind}/{datasetId}.json` path with NO
 * conflict check and NO pre-write self-consistency check -- exactly the gap
 * the task calls out ("If existing generic B-F5 writer cannot guarantee
 * validate-before-write, create a narrow B-M8 operator wrapper that builds
 * first, validates, then writes"). This module is that wrapper: an existing
 * artifact is read back and compared against the candidate's own semantic
 * identity before ANY write is even considered; a byte/identity-identical
 * artifact is a verified idempotent reuse, any difference fails closed.
 */
export const CANONICAL_DATASET_MANIFEST_ARTIFACT_ROOT = 'artifacts/research-lake/manifests';

export function canonicalDatasetManifestRelativePath(manifest: Pick<DatasetManifest, 'datasetKind' | 'datasetId'>): string {
  return `${manifest.datasetKind}/${manifest.datasetId}.json`;
}

export interface CanonicalDatasetManifestStoreResult {
  readonly relativePath: string;
  readonly absolutePath: string;
  readonly wasNewlyWritten: boolean;
}

export class CanonicalDatasetManifestConflictError extends Error {
  constructor(relativePath: string, reason: string) {
    super(`Existing canonical dataset manifest artifact at '${relativePath}' conflicts with the candidate manifest -- ${reason}. Refusing to overwrite (fail closed).`);
    this.name = 'CanonicalDatasetManifestConflictError';
  }
}

/** Recomputes `datasetChecksum` from a manifest's own sessions -- proves internal self-consistency (never trusts a manifest object's self-declared `datasetChecksum` field alone). */
function recomputeDatasetChecksum(manifest: DatasetManifest): string {
  return computeDatasetChecksum(manifest.sessions.map((session) => ({ identity: session.identity, canonicalizationVersion: session.canonicalizationVersion, healthSemanticsVersion: session.healthSemanticsVersion, contentChecksum: session.contentChecksum })));
}

/**
 * Persists the exact reconstructed canonical `DatasetManifest` at its
 * repository-native `{datasetKind}/{datasetId}.json` path. The candidate is
 * verified self-consistent (its own `datasetChecksum` re-hashes correctly)
 * BEFORE any filesystem interaction. An existing artifact at the same path
 * is read back and compared: if it is itself self-consistent AND its
 * `datasetChecksum` equals the candidate's, this is a verified idempotent
 * reuse (`wasNewlyWritten: false`); ANY difference throws
 * `CanonicalDatasetManifestConflictError` -- never a blind overwrite.
 */
export function storeCanonicalDatasetManifestArtifact(root: string, manifest: DatasetManifest): CanonicalDatasetManifestStoreResult {
  assertManifestSchemaCompatible(manifest);
  const recomputed = recomputeDatasetChecksum(manifest);
  if (recomputed !== manifest.datasetChecksum) {
    throw new Error(`storeCanonicalDatasetManifestArtifact: candidate manifest's self-declared datasetChecksum '${manifest.datasetChecksum}' does not match its own recomputed checksum '${recomputed}' -- refusing to persist an internally inconsistent manifest.`);
  }

  const relativePath = canonicalDatasetManifestRelativePath(manifest);
  const absolutePath = join(root, relativePath);

  if (fileExists(absolutePath)) {
    const existing = JSON.parse(readFileBuffer(absolutePath).toString('utf8')) as DatasetManifest;
    assertManifestSchemaCompatible(existing);
    const existingRecomputed = recomputeDatasetChecksum(existing);
    if (existing.datasetChecksum !== manifest.datasetChecksum || existingRecomputed !== manifest.datasetChecksum) {
      throw new CanonicalDatasetManifestConflictError(relativePath, `existing artifact datasetChecksum '${existing.datasetChecksum}' (recomputed '${existingRecomputed}') does not match candidate datasetChecksum '${manifest.datasetChecksum}'`);
    }
    return { relativePath, absolutePath, wasNewlyWritten: false };
  }

  const buffer = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  writeBufferAtomic(absolutePath, buffer);
  return { relativePath, absolutePath, wasNewlyWritten: true };
}

/** Read-only lookup for an already-persisted canonical manifest artifact -- fails closed (throws) if absent or schema-incompatible. Never invented as a second schema: the returned value is the exact, unmodified B-F5 `DatasetManifest` shape. */
export function readCanonicalDatasetManifestArtifact(root: string, datasetKind: ManifestDatasetKind, datasetId: string): DatasetManifest {
  const relativePath = `${datasetKind}/${datasetId}.json`;
  const absolutePath = join(root, relativePath);
  if (!fileExists(absolutePath)) {
    throw new Error(`No canonical dataset manifest artifact found at '${absolutePath}'.`);
  }
  const manifest = JSON.parse(readFileBuffer(absolutePath).toString('utf8')) as DatasetManifest;
  assertManifestSchemaCompatible(manifest);
  return manifest;
}
