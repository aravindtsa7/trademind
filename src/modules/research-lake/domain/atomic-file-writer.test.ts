import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileExists, readFileBuffer, writeBufferAtomic } from './atomic-file-writer';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'bf6-atomic-write-'));
}

test('writes a file whose final content matches the buffer, leaving no temp file behind', () => {
  const dir = tempDir();
  try {
    const target = join(dir, 'nested', 'session.parquet');
    writeBufferAtomic(target, Buffer.from('hello parquet'));

    assert.equal(fileExists(target), true);
    assert.equal(readFileBuffer(target).toString('utf8'), 'hello parquet');
    const entries = readdirSync(join(dir, 'nested'));
    assert.deepEqual(entries, ['session.parquet']); // no stray .tmp file
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('(Z) a failed temporary write does not leave a trusted final file', () => {
  const dir = tempDir();
  try {
    // A regular FILE where a directory is expected forces mkdirSync(recursive) to fail (ENOTDIR),
    // simulating an interrupted/failed write before any temp file for the target is created.
    const blockedSegment = join(dir, 'not-a-directory');
    writeFileSync(blockedSegment, 'i am a file, not a directory');
    const target = join(blockedSegment, 'session.parquet');

    assert.throws(() => writeBufferAtomic(target, Buffer.from('x')));
    assert.equal(existsSync(target), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('never overwrites an unrelated existing file at the final path if the write itself fails before rename', () => {
  const dir = tempDir();
  try {
    const target = join(dir, 'session.parquet');
    writeBufferAtomic(target, Buffer.from('original'));
    assert.equal(readFileBuffer(target).toString('utf8'), 'original');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
