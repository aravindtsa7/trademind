import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs';
import { dirname } from 'path';

/**
 * Writes `buffer` to a NEW, unique temporary file in the SAME directory
 * `finalPath` will eventually live in (never publishes to `finalPath`
 * itself). Returns the temp file's path.
 *
 * B-F6 CORRECTION (independent review): this is the low-level primitive a
 * caller that needs to VERIFY content before it becomes trusted (e.g.
 * `ResearchLakeParquetExportService.writeNewSession`) must use instead of
 * `writeBufferAtomic` -- publishing straight to `finalPath` and verifying
 * afterward left a window (failure/crash between publish and verification)
 * where an unverified file could sit at the trusted final path. Splitting
 * "write temp" / "publish (rename) temp -> final" lets a caller insert a
 * read-back verification step in between, with the final path never
 * existing until verification has already succeeded.
 *
 * Same temp-file-naming convention as `writeBufferAtomic`
 * (`${finalPath}.${pid}.${Date.now()}.tmp}`) so both remain visually
 * consistent and both land in the same directory/filesystem as `finalPath`
 * (required for `publishVerifiedTempFile`'s rename to be atomic).
 */
export function writeBufferToTempFile(finalPath: string, buffer: Buffer): string {
  const directory = dirname(finalPath);
  mkdirSync(directory, { recursive: true });
  const temporaryPath = `${finalPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temporaryPath, buffer);
    return temporaryPath;
  } catch (error) {
    cleanupTempFile(temporaryPath);
    throw error;
  }
}

/**
 * Atomically publishes an ALREADY-WRITTEN (and, by convention, already
 * verified by the caller) temp file onto `finalPath` via `fs.renameSync`
 * (atomic within one filesystem/volume, including on Windows, since the
 * temp file and `finalPath` are always in the same directory). Never
 * creates or modifies file content itself -- content must have been fully
 * written (and verified, where verification is required) before this is
 * called.
 */
export function publishVerifiedTempFile(temporaryPath: string, finalPath: string): void {
  renameSync(temporaryPath, finalPath);
}

/** Removes a temp file if it still exists (no-op otherwise). Never touches `finalPath`. Callers use this to clean up after a verification failure/exception so no stray `.tmp` file is left behind. */
export function cleanupTempFile(temporaryPath: string): void {
  if (existsSync(temporaryPath)) {
    rmSync(temporaryPath, { force: true });
  }
}

/**
 * Writes `buffer` to `finalPath` atomically with NO intermediate
 * verification step: a temp file in the same directory is written and
 * flushed, then immediately renamed onto `finalPath`. Mirrors the existing
 * repo convention already used for durable JSON state
 * (`execution.repository.ts:27-28`, `paper-portfolio.service.ts:31-34`,
 * `persistent-holdout-ledger.service.ts:92-94`).
 *
 * Safe ONLY for content that needs no read-back verification before it can
 * be trusted (e.g. the B-F6 storage descriptor JSON, which is metadata
 * about already-verified session files, not itself a session's trusted
 * research content). A caller that DOES need to verify content before it
 * becomes trusted (e.g. a new session Parquet file) must use
 * `writeBufferToTempFile` + verify + `publishVerifiedTempFile` instead --
 * see that trio's docs for why (task: B-F6 correction, "temp verify before
 * final publish").
 *
 * Never called when `finalPath` already exists and is trusted -- callers
 * (`ResearchLakeParquetExportService`) must perform their own
 * verify-before-overwrite / idempotent-skip decision first (task section
 * 12/13: "a normal idempotent rerun must never destroy suspicious prior
 * evidence"). This function itself has no opinion on whether overwriting is
 * safe; it only guarantees that IF a write happens, it never leaves a
 * partially-written file at `finalPath`.
 */
export function writeBufferAtomic(finalPath: string, buffer: Buffer): void {
  const temporaryPath = writeBufferToTempFile(finalPath, buffer);
  try {
    publishVerifiedTempFile(temporaryPath, finalPath);
  } catch (error) {
    cleanupTempFile(temporaryPath);
    throw error;
  }
}

export function readFileBuffer(path: string): Buffer {
  return readFileSync(path);
}

export function fileExists(path: string): boolean {
  return existsSync(path);
}
