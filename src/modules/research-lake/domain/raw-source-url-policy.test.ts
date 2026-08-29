import assert from 'node:assert/strict';
import test from 'node:test';
import { RawSourceUrlPolicyError, assertApprovedRawSourceUrl, isPrivateOrLoopbackHost } from './raw-source-url-policy';

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
    assert.fail(`Expected RawSourceUrlPolicyError with code ${code}, but no error was thrown.`);
  } catch (error) {
    assert.ok(error instanceof RawSourceUrlPolicyError, `Expected RawSourceUrlPolicyError, got ${error}`);
    assert.equal((error as RawSourceUrlPolicyError).code, code);
  }
}

test('(5) accepts an https URL on the current approved host under the approved path', () => {
  assert.doesNotThrow(() => assertApprovedRawSourceUrl('https://nsearchives.nseindia.com/content/circulars/CMPT59722.pdf'));
});

test('accepts the legacy approved host', () => {
  assert.doesNotThrow(() => assertApprovedRawSourceUrl('https://archives.nseindia.com/content/circulars/CMPT59722.pdf'));
});

test('(6) HTTPS is required', () => {
  expectCode(() => assertApprovedRawSourceUrl('http://nsearchives.nseindia.com/content/circulars/x.pdf'), 'NON_HTTPS_SCHEME');
});

test('rejects non-HTTP schemes entirely (file:// and data:)', () => {
  // Both parse as well-formed URLs but fail the HTTPS-only requirement -- still hard-rejected, never treated as HTTP(S).
  expectCode(() => assertApprovedRawSourceUrl('file:///etc/passwd'), 'NON_HTTPS_SCHEME');
  expectCode(() => assertApprovedRawSourceUrl('data:text/plain;base64,aGVsbG8='), 'NON_HTTPS_SCHEME');
});

test('rejects a malformed URL', () => {
  expectCode(() => assertApprovedRawSourceUrl('not a url'), 'MALFORMED_URL');
});

test('(5) rejects a host outside the approved allowlist', () => {
  expectCode(() => assertApprovedRawSourceUrl('https://evil.example.com/content/circulars/x.pdf'), 'HOST_NOT_APPROVED');
});

test('rejects an approved host with an unapproved path', () => {
  expectCode(() => assertApprovedRawSourceUrl('https://nsearchives.nseindia.com/some-other-path/x.pdf'), 'PATH_NOT_APPROVED');
});

test('(no arbitrary redirect to non-approved host) rejects a would-be redirect target outside the allowlist', () => {
  // The downloader calls this same function on every redirect Location header
  // before following it -- exercised here directly against a raw target URL.
  expectCode(() => assertApprovedRawSourceUrl('https://attacker.example.com/content/circulars/x.pdf'), 'HOST_NOT_APPROVED');
});

test('no localhost/private-network SSRF target: rejects loopback/private literals even on an otherwise-approved-looking path', () => {
  expectCode(() => assertApprovedRawSourceUrl('https://localhost/content/circulars/x.pdf'), 'PRIVATE_OR_LOOPBACK_HOST');
  expectCode(() => assertApprovedRawSourceUrl('https://127.0.0.1/content/circulars/x.pdf'), 'PRIVATE_OR_LOOPBACK_HOST');
  expectCode(() => assertApprovedRawSourceUrl('https://10.0.0.5/content/circulars/x.pdf'), 'PRIVATE_OR_LOOPBACK_HOST');
  expectCode(() => assertApprovedRawSourceUrl('https://192.168.1.1/content/circulars/x.pdf'), 'PRIVATE_OR_LOOPBACK_HOST');
  expectCode(() => assertApprovedRawSourceUrl('https://172.16.0.1/content/circulars/x.pdf'), 'PRIVATE_OR_LOOPBACK_HOST');
});

test('isPrivateOrLoopbackHost classifies representative hosts correctly', () => {
  assert.equal(isPrivateOrLoopbackHost('localhost'), true);
  assert.equal(isPrivateOrLoopbackHost('127.0.0.1'), true);
  assert.equal(isPrivateOrLoopbackHost('10.1.2.3'), true);
  assert.equal(isPrivateOrLoopbackHost('172.20.0.1'), true);
  assert.equal(isPrivateOrLoopbackHost('192.168.0.1'), true);
  assert.equal(isPrivateOrLoopbackHost('169.254.1.1'), true);
  assert.equal(isPrivateOrLoopbackHost('nsearchives.nseindia.com'), false);
  assert.equal(isPrivateOrLoopbackHost('172.32.0.1'), false); // just outside the 172.16-31 RFC1918 band
  assert.equal(isPrivateOrLoopbackHost('8.8.8.8'), false);
});
