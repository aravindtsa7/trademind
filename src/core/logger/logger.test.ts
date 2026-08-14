import assert from 'node:assert/strict';
import test from 'node:test';
import logger, { redactLogValue } from './logger';

test('logger redaction handles circular objects without throwing', () => {
  const value: Record<string, unknown> = { message: 'normal' };
  value.self = value;
  assert.doesNotThrow(() => redactLogValue(value));
  assert.equal((redactLogValue(value) as Record<string, unknown>).self, '[CIRCULAR_REFERENCE]');
  assert.doesNotThrow(() => logger.error('circular logger test', { value }));
});

test('logger sanitizes Axios-like circular errors while retaining operational fields', () => {
  const error = Object.assign(new Error('Request failed: Authorization: Bearer hidden'), {
    code: 'ERR_BAD_REQUEST',
    status: 401,
    config: { headers: { Authorization: 'Bearer hidden' } },
  }) as Error & { request?: unknown };
  error.request = { error };
  const safe = redactLogValue({ error }) as { error: Record<string, unknown> };
  assert.equal(safe.error.name, 'Error');
  assert.equal(safe.error.code, 'ERR_BAD_REQUEST');
  assert.equal(safe.error.status, 401);
  assert.match(String(safe.error.message), /\[REDACTED\]/);
  assert.doesNotThrow(() => JSON.stringify(safe));
});

test('logger redacts authorization and nested bearer/access-token fields', () => {
  const safe = redactLogValue({ Authorization: 'Bearer secret', nested: { token: 'abc', message: 'bearer abc.def' }, accessToken: 'xyz' }) as Record<string, any>;
  assert.equal(safe.Authorization, '[REDACTED]');
  assert.equal(safe.nested.token, '[REDACTED]');
  assert.match(safe.nested.message, /\[REDACTED\]/);
  assert.equal(safe.accessToken, '[REDACTED]');
});

test('logger limits excessive depth and represents repeated references safely', () => {
  const shared = { name: 'shared' }; const root: Record<string, unknown> = { first: shared, second: shared };
  let cursor: Record<string, unknown> = root; for (let index = 0; index < 8; index += 1) { cursor.next = {}; cursor = cursor.next as Record<string, unknown>; }
  const safe = redactLogValue(root) as Record<string, any>;
  assert.equal(safe.second, '[CIRCULAR_REFERENCE]');
  assert.match(JSON.stringify(safe), /MAX_LOG_DEPTH/);
});
