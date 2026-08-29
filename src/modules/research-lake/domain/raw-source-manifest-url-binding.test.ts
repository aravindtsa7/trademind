import assert from 'node:assert/strict';
import test from 'node:test';
import { RawSourceUrlBindingError, assertUrlBindsToReference, deriveExpectedRawSourceUrl, deriveExpectedRawSourceUrlBasename } from './raw-source-manifest-url-binding';

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
