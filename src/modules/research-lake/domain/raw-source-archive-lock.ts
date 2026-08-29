import { promises as fsPromises } from 'fs';
import { hostname } from 'os';
import { join } from 'path';

/**
 * B-F7A-ARCHIVE-1-FIX-1 Defect C correction (task section 9/10). Provides
 * process-independent exclusive serialization around the archive's
 * receipt-index read -> reconcile -> blob-publish -> receipt-publish state
 * transition, using atomic lock-FILE-acquisition (`O_EXCL` create, via
 * Node's `wx` flag) rather than a JavaScript in-process mutex -- an
 * in-process mutex cannot protect two separate `node` invocations, which is
 * exactly the race Terra proved (task section 9: "Do NOT implement a
 * process-local JavaScript mutex only. It must protect separate Node
 * processes.").
 *
 * Stale-lock reclaim is intentionally conservative (task section 10): a
 * lock is only ever force-reclaimed when there is STRONG evidence its owner
 * is dead -- same hostname AND `process.kill(pid, 0)` proves no such PID is
 * running on this machine. Anything else (different hostname, a live PID, or
 * an unreadable/malformed lock file) is treated as "still possibly held" and
 * this function keeps waiting until `timeoutMs`, then fails closed. This is
 * deliberately a single-machine-only guarantee (task section 10: "another
 * durable exclusive mechanism appropriate to this single-machine archive
 * tool") -- it does not attempt distributed/cross-host lock ownership proof.
 */

const LOCK_FILE_NAME = 'archive.lock';
const DEFAULT_ACQUIRE_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_INTERVAL_MS = 100;

export type RawSourceArchiveLockErrorCode = 'LOCK_ACQUISITION_TIMEOUT' | 'LOCK_ACQUISITION_ERROR';

export class RawSourceArchiveLockError extends Error {
  constructor(public readonly code: RawSourceArchiveLockErrorCode, message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'RawSourceArchiveLockError';
  }
}

export interface RawSourceArchiveLockHandle {
  readonly lockPath: string;
  release(): Promise<void>;
}

interface LockFileContent {
  readonly pid: number;
  readonly hostname: string;
  readonly acquiredAt: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** `true` only when this is provably the SAME machine and the PID no longer exists here (task section 10: "strong ownership evidence", never a bare elapsed-time guess). */
async function isProvablyStale(lockPath: string): Promise<boolean> {
  let content: LockFileContent;
  try {
    const raw = await fsPromises.readFile(lockPath, 'utf8');
    content = JSON.parse(raw) as LockFileContent;
  } catch {
    return false; // unreadable/malformed -- never treated as proof of staleness
  }
  if (typeof content.pid !== 'number' || typeof content.hostname !== 'string') return false;
  if (content.hostname !== hostname()) return false; // cannot prove liveness of a PID on a different host

  try {
    process.kill(content.pid, 0); // throws if no such process; does not actually signal it
    return false; // process is alive -- lock is NOT stale
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

/**
 * Acquires the exclusive archive lock under `archiveRoot`, polling on
 * `EEXIST` until either it succeeds, a provably-stale lock is safely
 * reclaimed, or `timeoutMs` elapses (task section 10: "bounded acquisition
 * wait/timeout... no silent parallel fallback... clear typed error on lock
 * acquisition failure"). Callers MUST call `.release()` in a `finally` block
 * (task section 10: "cleanup in finally").
 */
export async function acquireRawSourceArchiveLock(
  archiveRoot: string,
  options: { readonly timeoutMs?: number; readonly pollIntervalMs?: number } = {}
): Promise<RawSourceArchiveLockHandle> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_ACQUIRE_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const lockPath = join(archiveRoot, LOCK_FILE_NAME);

  await fsPromises.mkdir(archiveRoot, { recursive: true });
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    try {
      const handle = await fsPromises.open(lockPath, 'wx');
      const content: LockFileContent = { pid: process.pid, hostname: hostname(), acquiredAt: new Date().toISOString() };
      try {
        await handle.writeFile(JSON.stringify(content));
      } finally {
        await handle.close();
      }
      return {
        lockPath,
        release: async () => {
          await fsPromises.unlink(lockPath).catch(() => undefined);
        },
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') {
        throw new RawSourceArchiveLockError('LOCK_ACQUISITION_ERROR', `Failed to acquire archive lock at '${lockPath}': ${error instanceof Error ? error.message : String(error)}`, error);
      }

      if (await isProvablyStale(lockPath)) {
        await fsPromises.unlink(lockPath).catch(() => undefined); // provably dead owner -- safe to reclaim; loop retries the exclusive create
        continue;
      }

      if (Date.now() >= deadline) {
        throw new RawSourceArchiveLockError('LOCK_ACQUISITION_TIMEOUT', `Timed out after ${timeoutMs}ms waiting for the archive lock at '${lockPath}' (held by another process/run).`);
      }
      await sleep(pollIntervalMs);
    }
  }
}
