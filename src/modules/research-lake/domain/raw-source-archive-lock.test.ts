import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { RawSourceArchiveLockError, acquireRawSourceArchiveLock } from './raw-source-archive-lock';

function tempArchiveRoot(): string {
  return mkdtempSync(join(tmpdir(), 'raw-source-archive-lock-test-'));
}

test('acquires and releases the lock cleanly when uncontended', async () => {
  const root = tempArchiveRoot();
  try {
    const lock = await acquireRawSourceArchiveLock(root);
    assert.ok(existsSync(lock.lockPath));
    await lock.release();
    assert.equal(existsSync(lock.lockPath), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('(24) a lock held by a live process (this test process) causes a second acquisition attempt to time out rather than silently proceeding', async () => {
  const root = tempArchiveRoot();
  try {
    const first = await acquireRawSourceArchiveLock(root);
    try {
      await assert.rejects(
        () => acquireRawSourceArchiveLock(root, { timeoutMs: 300, pollIntervalMs: 50 }),
        (error: unknown) => error instanceof RawSourceArchiveLockError && error.code === 'LOCK_ACQUISITION_TIMEOUT'
      );
    } finally {
      await first.release();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a lock claiming a different hostname is never reclaimed on elapsed time alone (fails closed as still-possibly-held)', async () => {
  const root = tempArchiveRoot();
  try {
    const lockPath = join(root, 'archive.lock');
    writeFileSync(lockPath, JSON.stringify({ pid: 999999, hostname: 'some-other-machine-entirely', acquiredAt: new Date(0).toISOString() }));
    await assert.rejects(
      () => acquireRawSourceArchiveLock(root, { timeoutMs: 300, pollIntervalMs: 50 }),
      (error: unknown) => error instanceof RawSourceArchiveLockError && error.code === 'LOCK_ACQUISITION_TIMEOUT'
    );
    assert.ok(existsSync(lockPath), 'a lock that cannot be proven stale must never be deleted');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a malformed lock file is never treated as proof of staleness -- fails closed', async () => {
  const root = tempArchiveRoot();
  try {
    const lockPath = join(root, 'archive.lock');
    writeFileSync(lockPath, 'not valid json at all');
    await assert.rejects(
      () => acquireRawSourceArchiveLock(root, { timeoutMs: 300, pollIntervalMs: 50 }),
      (error: unknown) => error instanceof RawSourceArchiveLockError && error.code === 'LOCK_ACQUISITION_TIMEOUT'
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a lock on THIS machine whose PID no longer exists is provably stale and is safely reclaimed', async () => {
  const root = tempArchiveRoot();
  try {
    const lockPath = join(root, 'archive.lock');
    // A PID essentially guaranteed not to exist -- proves reclaim only fires on genuine same-host dead-PID evidence.
    const definitelyDeadPid = 999999;
    writeFileSync(lockPath, JSON.stringify({ pid: definitelyDeadPid, hostname: hostname(), acquiredAt: new Date(0).toISOString() }));
    const lock = await acquireRawSourceArchiveLock(root, { timeoutMs: 2000, pollIntervalMs: 50 });
    await lock.release();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('(20/concurrency) two concurrent acquisition attempts against the same archive root serialize -- only one holds the lock at a time', async () => {
  const root = tempArchiveRoot();
  try {
    const order: string[] = [];
    const first = acquireRawSourceArchiveLock(root, { timeoutMs: 5000, pollIntervalMs: 20 }).then(async (lock) => {
      order.push('A-acquired');
      await new Promise((resolve) => setTimeout(resolve, 150));
      order.push('A-released');
      await lock.release();
    });
    // Stagger slightly so A is very likely first, then race B in immediately after.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = acquireRawSourceArchiveLock(root, { timeoutMs: 5000, pollIntervalMs: 20 }).then(async (lock) => {
      order.push('B-acquired');
      await lock.release();
    });
    await Promise.all([first, second]);
    // B must never acquire before A releases.
    assert.equal(order[0], 'A-acquired');
    assert.equal(order.indexOf('B-acquired') > order.indexOf('A-released'), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
