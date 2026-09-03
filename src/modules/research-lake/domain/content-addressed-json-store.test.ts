import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import {
  ContentAddressedJsonStoreError,
  contentAddressedJsonRelativePath,
  readContentAddressedJson,
  storeContentAddressedJson,
} from './content-addressed-json-store';

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'content-addressed-json-store-test-'));
}

interface Doc {
  readonly value: string;
}

function checksumOf(doc: Doc): string {
  return createHash('sha256').update(JSON.stringify(doc)).digest('hex');
}

test('contentAddressedJsonRelativePath rejects a non-hex/wrong-length checksum', () => {
  assert.throws(() => contentAddressedJsonRelativePath('sub', 'not-a-hash'), ContentAddressedJsonStoreError);
  assert.throws(() => contentAddressedJsonRelativePath('sub', 'a'.repeat(63)), ContentAddressedJsonStoreError);
});

test('contentAddressedJsonRelativePath is forward-slashed and content-addressed', () => {
  const hash = 'a'.repeat(64);
  assert.equal(contentAddressedJsonRelativePath('sub', hash), `sub/${hash}.json`);
});

test('storeContentAddressedJson writes a new document atomically and is newly-written', () => {
  const root = tempRoot();
  try {
    const doc: Doc = { value: 'hello' };
    const checksum = checksumOf(doc);
    const result = storeContentAddressedJson(root, 'docs', checksum, doc, checksumOf);
    assert.equal(result.wasNewlyWritten, true);
    const readBack = readContentAddressedJson<Doc>(root, 'docs', checksum);
    assert.deepEqual(readBack, doc);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('storeContentAddressedJson is idempotent: writing the identical content twice is a verified skip the second time', () => {
  const root = tempRoot();
  try {
    const doc: Doc = { value: 'hello' };
    const checksum = checksumOf(doc);
    const first = storeContentAddressedJson(root, 'docs', checksum, doc, checksumOf);
    const second = storeContentAddressedJson(root, 'docs', checksum, doc, checksumOf);
    assert.equal(first.wasNewlyWritten, true);
    assert.equal(second.wasNewlyWritten, false);
    assert.equal(first.absolutePath, second.absolutePath);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('storeContentAddressedJson never overwrites corrupted existing content at the same content-addressed path', () => {
  const root = tempRoot();
  try {
    const doc: Doc = { value: 'hello' };
    const checksum = checksumOf(doc);
    const relativePath = contentAddressedJsonRelativePath('docs', checksum);
    const absolutePath = join(root, relativePath);
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, JSON.stringify({ value: 'tampered' }), { flag: 'wx', encoding: 'utf8' });
    assert.throws(
      () => storeContentAddressedJson(root, 'docs', checksum, doc, checksumOf),
      (error: unknown) => error instanceof ContentAddressedJsonStoreError && error.code === 'EXISTING_CONTENT_CORRUPTED'
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('readContentAddressedJson fails closed (CONTENT_NOT_FOUND) when nothing exists at that checksum', () => {
  const root = tempRoot();
  try {
    assert.throws(
      () => readContentAddressedJson(root, 'docs', 'b'.repeat(64)),
      (error: unknown) => error instanceof ContentAddressedJsonStoreError && error.code === 'CONTENT_NOT_FOUND'
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- B-M7.1-MEDIUM-01: content-addressed store root containment ----------

function isInvalidSubdirError(error: unknown): boolean {
  return error instanceof ContentAddressedJsonStoreError && error.code === 'INVALID_SUBDIR';
}

test('1. a safe fixed subdir passes', () => {
  const root = tempRoot();
  try {
    const doc: Doc = { value: 'safe-fixed' };
    const checksum = checksumOf(doc);
    const result = storeContentAddressedJson(root, 'docs', checksum, doc, checksumOf);
    assert.equal(result.wasNewlyWritten, true);
    assert.ok(result.absolutePath.startsWith(resolve(root)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('2. a safe nested relative subdir passes', () => {
  const root = tempRoot();
  try {
    const doc: Doc = { value: 'safe-nested' };
    const checksum = checksumOf(doc);
    const result = storeContentAddressedJson(root, 'nested/sub', checksum, doc, checksumOf);
    assert.equal(result.wasNewlyWritten, true);
    const readBack = readContentAddressedJson<Doc>(root, 'nested/sub', checksum);
    assert.deepEqual(readBack, doc);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('2b. a subdir that syntactically contains ".." but resolves back inside root after normalization is allowed (checks the RESOLVED path, never the raw string)', () => {
  const root = tempRoot();
  try {
    const doc: Doc = { value: 'safe-collapsing' };
    const checksum = checksumOf(doc);
    const result = storeContentAddressedJson(root, 'safe/nested/../other', checksum, doc, checksumOf);
    assert.equal(result.wasNewlyWritten, true);
    assert.ok(result.absolutePath.startsWith(resolve(root)));
    const readBack = readContentAddressedJson<Doc>(root, 'safe/other', checksum);
    assert.deepEqual(readBack, doc);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('3. ../escape is rejected', () => {
  const root = tempRoot();
  try {
    const doc: Doc = { value: 'escape' };
    const checksum = checksumOf(doc);
    assert.throws(() => storeContentAddressedJson(root, '../escape', checksum, doc, checksumOf), isInvalidSubdirError);
    assert.throws(() => readContentAddressedJson(root, '../escape', checksum), isInvalidSubdirError);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('4. safe/../../escape (nested traversal that genuinely escapes) is rejected', () => {
  const root = tempRoot();
  try {
    const doc: Doc = { value: 'nested-escape' };
    const checksum = checksumOf(doc);
    assert.throws(() => storeContentAddressedJson(root, 'safe/../../escape', checksum, doc, checksumOf), isInvalidSubdirError);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('5. an absolute Windows-style path is rejected', () => {
  const root = tempRoot();
  try {
    const doc: Doc = { value: 'abs-windows' };
    const checksum = checksumOf(doc);
    assert.throws(() => storeContentAddressedJson(root, 'C:\\Windows\\System32', checksum, doc, checksumOf), isInvalidSubdirError);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('6. an absolute POSIX-style path is rejected (this platform treats a leading "/" as absolute)', () => {
  const root = tempRoot();
  try {
    const doc: Doc = { value: 'abs-posix' };
    const checksum = checksumOf(doc);
    assert.throws(() => storeContentAddressedJson(root, '/etc/passwd', checksum, doc, checksumOf), isInvalidSubdirError);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('7. "." (resolves to the root itself, not a genuine subdirectory) is rejected', () => {
  const root = tempRoot();
  try {
    const doc: Doc = { value: 'dot' };
    const checksum = checksumOf(doc);
    assert.throws(() => storeContentAddressedJson(root, '.', checksum, doc, checksumOf), isInvalidSubdirError);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('8. an empty subdir is rejected', () => {
  const root = tempRoot();
  try {
    const doc: Doc = { value: 'empty' };
    const checksum = checksumOf(doc);
    assert.throws(() => storeContentAddressedJson(root, '', checksum, doc, checksumOf), isInvalidSubdirError);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('10. no artifact is ever created outside root when a traversal attempt is made', () => {
  const root = tempRoot();
  try {
    const doc: Doc = { value: 'never-written' };
    const checksum = checksumOf(doc);
    assert.throws(() => storeContentAddressedJson(root, '../escape', checksum, doc, checksumOf));
    const wouldHaveEscapedTo = resolve(root, '..', 'escape', `${checksum}.json`);
    assert.equal(existsSync(wouldHaveEscapedTo), false);
    assert.equal(existsSync(resolve(root, '..', 'escape')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('contentAddressedJsonRelativePath itself rejects an absolute or empty subdir (cheap, root-independent shape check)', () => {
  assert.throws(() => contentAddressedJsonRelativePath('', 'a'.repeat(64)), isInvalidSubdirError);
  assert.throws(() => contentAddressedJsonRelativePath('C:\\Windows', 'a'.repeat(64)), isInvalidSubdirError);
  assert.throws(() => contentAddressedJsonRelativePath('/etc', 'a'.repeat(64)), isInvalidSubdirError);
});
