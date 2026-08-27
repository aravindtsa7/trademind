import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalManifestJson, sha256Hex } from './dataset-manifest-canonical-json';

test('object key order does not affect canonical output (deterministic key sorting)', () => {
  const a = canonicalManifestJson({ b: 1, a: 2, c: 3 });
  const b = canonicalManifestJson({ c: 3, a: 2, b: 1 });
  assert.equal(a, b);
  assert.equal(a, '{"a":2,"b":1,"c":3}');
});

test('array element order IS preserved (never sorted -- callers sort arrays themselves when order is semantic)', () => {
  const a = canonicalManifestJson([3, 1, 2]);
  const b = canonicalManifestJson([1, 2, 3]);
  assert.notEqual(a, b);
  assert.equal(a, '[3,1,2]');
});

test('bigint serializes via toString(), never through JSON.stringify (which would throw)', () => {
  assert.equal(canonicalManifestJson(500n), '"500"');
  assert.equal(canonicalManifestJson(0n), '"0"');
});

test('Date serializes via toISOString(), independent of host timezone', () => {
  const date = new Date('2022-01-03T09:15:00.000Z');
  assert.equal(canonicalManifestJson(date), '"2022-01-03T09:15:00.000Z"');
});

test('null and "absent bigint" (openInterest: null) are explicit and distinct from each other', () => {
  const withNull = canonicalManifestJson({ openInterest: null });
  const withZero = canonicalManifestJson({ openInterest: 0n });
  assert.notEqual(withNull, withZero);
  assert.equal(withNull, '{"openInterest":null}');
  assert.equal(withZero, '{"openInterest":"0"}');
});

test('undefined is rejected rather than silently treated as null or dropped', () => {
  assert.throws(() => canonicalManifestJson({ a: undefined }), /undefined is not a valid manifest content value/);
  assert.throws(() => canonicalManifestJson(undefined), /undefined is not a valid manifest content value/);
});

test('non-finite numbers are rejected (not valid deterministic manifest content)', () => {
  assert.throws(() => canonicalManifestJson(Number.NaN));
  assert.throws(() => canonicalManifestJson(Number.POSITIVE_INFINITY));
});

test('nested structures are canonicalized recursively and deterministically', () => {
  const a = canonicalManifestJson({ outer: { z: 1n, a: new Date('2022-01-03T00:00:00.000Z') } });
  const b = canonicalManifestJson({ outer: { a: new Date('2022-01-03T00:00:00.000Z'), z: 1n } });
  assert.equal(a, b);
});

test('sha256Hex is deterministic for identical input and differs for any content change', () => {
  const first = sha256Hex(canonicalManifestJson({ a: 1, b: 2n }));
  const second = sha256Hex(canonicalManifestJson({ b: 2n, a: 1 }));
  const mutated = sha256Hex(canonicalManifestJson({ a: 1, b: 3n }));
  assert.equal(first, second);
  assert.notEqual(first, mutated);
  assert.equal(first.length, 64); // full SHA-256 hex digest, never truncated for a content-integrity checksum
});
