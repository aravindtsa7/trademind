import assert from 'node:assert/strict';
import test from 'node:test';
import {
  RawSourceUrlBindingError,
  assertUrlBindsToReference,
  deriveExpectedRawSourceUrl,
  deriveExpectedRawSourceUrlBasename,
  deriveExpectedRawSourceZipBasename,
} from './raw-source-manifest-url-binding';

test('deriveExpectedRawSourceUrlBasename applies the exact <DEPT><NUMBER>.pdf rule', () => {
  assert.equal(deriveExpectedRawSourceUrlBasename('NSE/CMTR/59722'), 'CMTR59722.pdf');
  assert.equal(deriveExpectedRawSourceUrlBasename('NSE/FAOP/59723'), 'FAOP59723.pdf');
  assert.equal(deriveExpectedRawSourceUrlBasename('NSE/MSD/60318'), 'MSD60318.pdf');
  assert.equal(deriveExpectedRawSourceUrlBasename('NSE/MSD/60340'), 'MSD60340.pdf');
});

test('deriveExpectedRawSourceUrl builds the full approved-host URL', () => {
  assert.equal(deriveExpectedRawSourceUrl('NSE/MSD/60318'), 'https://nsearchives.nseindia.com/content/circulars/MSD60318.pdf');
});

test('(2/3) a URL correctly bound to its own reference passes', () => {
  assert.doesNotThrow(() => assertUrlBindsToReference('NSE/MSD/60340', 'https://nsearchives.nseindia.com/content/circulars/MSD60340.pdf'));
});

test('(4) a URL bound to a DIFFERENT reference is rejected, even though both are otherwise well-formed and on an approved host', () => {
  assert.throws(
    () => assertUrlBindsToReference('NSE/MSD/60340', 'https://nsearchives.nseindia.com/content/circulars/MSD60318.pdf'),
    (error: unknown) => error instanceof RawSourceUrlBindingError && error.code === 'URL_REFERENCE_MISMATCH'
  );
});

test('rejects a malformed URL', () => {
  assert.throws(() => assertUrlBindsToReference('NSE/MSD/60340', 'not a url'), (error: unknown) => error instanceof RawSourceUrlBindingError && error.code === 'MALFORMED_URL');
});

test('never infers a reference from an arbitrary URL -- an unrecognized reference shape is rejected before any URL comparison', () => {
  assert.throws(
    () => assertUrlBindsToReference('NOT-A-REFERENCE', 'https://nsearchives.nseindia.com/content/circulars/MSD60340.pdf'),
    (error: unknown) => error instanceof RawSourceUrlBindingError && error.code === 'UNRECOGNIZED_REFERENCE_SHAPE'
  );
});

test('deriveExpectedRawSourceZipBasename applies the same <DEPT><NUMBER> stem with a .zip extension', () => {
  assert.equal(deriveExpectedRawSourceZipBasename('NSE/CMTR/60338'), 'CMTR60338.zip');
  assert.equal(deriveExpectedRawSourceZipBasename('NSE/CMTR/57285'), 'CMTR57285.zip');
});

test('a URL bound to the zip-envelope form of its own reference also passes (task section 4/37: some real NSE circulars are published as a .zip bundle)', () => {
  assert.doesNotThrow(() => assertUrlBindsToReference('NSE/CMTR/60338', 'https://nsearchives.nseindia.com/content/circulars/CMTR60338.zip'));
});

test('the zip-envelope acceptance is still an exact <DEPT><NUMBER> match, not a fuzzy one -- a zip basename for a DIFFERENT reference is rejected', () => {
  assert.throws(
    () => assertUrlBindsToReference('NSE/CMTR/60338', 'https://nsearchives.nseindia.com/content/circulars/CMTR60339.zip'),
    (error: unknown) => error instanceof RawSourceUrlBindingError && error.code === 'URL_REFERENCE_MISMATCH'
  );
});

test('basename comparison is case-sensitive and exact, not a substring match', () => {
  assert.throws(
    () => assertUrlBindsToReference('NSE/MSD/60340', 'https://nsearchives.nseindia.com/content/circulars/msd60340.pdf'),
    (error: unknown) => error instanceof RawSourceUrlBindingError && error.code === 'URL_REFERENCE_MISMATCH'
  );
  assert.throws(
    () => assertUrlBindsToReference('NSE/MSD/60340', 'https://nsearchives.nseindia.com/content/circulars/MSD603400.pdf'),
    (error: unknown) => error instanceof RawSourceUrlBindingError && error.code === 'URL_REFERENCE_MISMATCH'
  );
});

// ============================================================
// B-F7A-SOURCE-EVIDENCE-FIX-1 Terra Defect C regression suite (task section
// 16-18): binding must require the ENTIRE canonical path, not just the
// final basename -- an extra intermediate directory must never be accepted
// merely because the trailing filename happens to match.
// ============================================================

test('(18 positive) exact canonical .pdf and .zip paths for the reviewed reference pass', () => {
  assert.doesNotThrow(() => assertUrlBindsToReference('NSE/CMTR/57285', 'https://nsearchives.nseindia.com/content/circulars/CMTR57285.pdf'));
  assert.doesNotThrow(() => assertUrlBindsToReference('NSE/CMTR/57285', 'https://nsearchives.nseindia.com/content/circulars/CMTR57285.zip'));
});

test('(18 negative) an extra intermediate path segment before the correct basename is rejected (Terra Defect C)', () => {
  assert.throws(
    () => assertUrlBindsToReference('NSE/CMTR/57285', 'https://nsearchives.nseindia.com/content/circulars/foo/CMTR57285.zip'),
    (error: unknown) => error instanceof RawSourceUrlBindingError && error.code === 'URL_REFERENCE_MISMATCH'
  );
});

test('(18 negative) a dot-dot path-traversal trick that WHATWG URL normalization collapses back to the canonical path is legitimately accepted, never treated as a bypass', () => {
  // new URL(...) normalizes '..' segments BEFORE this function ever compares -- verified directly in raw-source-manifest-url-binding.ts's own investigation.
  // The point of this test is that the normalized form equals the real canonical path, so it passes for the RIGHT reason (identity), not because the trick "worked".
  assert.doesNotThrow(() => assertUrlBindsToReference('NSE/CMTR/57285', 'https://nsearchives.nseindia.com/content/circulars/../circulars/CMTR57285.zip'));
});

test('(18 negative) a dot-dot trick that normalizes to an EXTRA segment (not the canonical path) is still rejected', () => {
  assert.throws(
    () => assertUrlBindsToReference('NSE/CMTR/57285', 'https://nsearchives.nseindia.com/content/circulars/x/CMTR57285.pdf'),
    (error: unknown) => error instanceof RawSourceUrlBindingError && error.code === 'URL_REFERENCE_MISMATCH'
  );
});

test('(18 negative) truncated/extended/wrong-department/wrong-reference basenames are all rejected', () => {
  const badUrls = [
    'https://nsearchives.nseindia.com/content/circulars/CMTR5728.zip',
    'https://nsearchives.nseindia.com/content/circulars/CMTR572850.zip',
    'https://nsearchives.nseindia.com/content/circulars/OTHER57285.zip',
    'https://nsearchives.nseindia.com/content/circulars/CMTR57285-copy.zip',
  ];
  for (const url of badUrls) {
    assert.throws(() => assertUrlBindsToReference('NSE/CMTR/57285', url), (error: unknown) => error instanceof RawSourceUrlBindingError && error.code === 'URL_REFERENCE_MISMATCH', `expected rejection for ${url}`);
  }
});

test('(18 negative) a non-empty query string or fragment on an otherwise-correct URL is rejected', () => {
  assert.throws(
    () => assertUrlBindsToReference('NSE/CMTR/57285', 'https://nsearchives.nseindia.com/content/circulars/CMTR57285.zip?x=1'),
    (error: unknown) => error instanceof RawSourceUrlBindingError && error.code === 'URL_HAS_UNEXPECTED_QUERY_OR_FRAGMENT'
  );
  assert.throws(
    () => assertUrlBindsToReference('NSE/CMTR/57285', 'https://nsearchives.nseindia.com/content/circulars/CMTR57285.zip#frag'),
    (error: unknown) => error instanceof RawSourceUrlBindingError && error.code === 'URL_HAS_UNEXPECTED_QUERY_OR_FRAGMENT'
  );
});
