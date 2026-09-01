import assert from 'node:assert/strict';
import test from 'node:test';
import logger, { redactLogValue } from './logger';

// Symbol.for('message') is the well-known global-registry symbol winston's logform/json format
// uses to stash the fully-formatted, JSON-serialized log line on the `info` object -- reading it
// proves a field survived the ENTIRE real pipeline (errors -> splat -> redaction -> timestamp ->
// json), not merely the redaction step in isolation. No extra package import needed: it's a
// registry symbol, and winston's own Logger reads it the identical way internally.
const MESSAGE = Symbol.for('message');

/**
 * Runs `meta` through the SAME format pipeline (errors/splat/redactSecrets/timestamp/json) the
 * real singleton `logger` applies to every log call -- `logger.format` is the exact combined
 * format winston's own Logger.write() invokes internally (`this.format.transform(info, ...)`),
 * so this is the real production seam, not a reimplementation, and requires no extra transport or
 * dependency.
 */
function formatAsProduction(level: string, message: string, meta: Record<string, unknown>): Record<string, unknown> {
  const info = { level, message, ...meta };
  return logger.format.transform(info, (logger.format as { options?: unknown }).options) as Record<string, unknown>;
}

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

// Terra MEDIUM finding: the new WebSocket diagnostic fields (socketId, isCurrentSocket) were
// silently transformed into '[OMITTED_UNSAFE_OBJECT]' by unsafeObjectKey's *socket*/*connection*/
// etc. key-name pattern, so the intended observability never survived the real logging pipeline.
// The fix renamed them to wsId/isCurrentWs/wsReadyState. This test is the regression guard: it
// must fail again if anyone reverts to a key name matching that pattern.
test('logger redaction preserves WebSocket diagnostic scalars (wsId/isCurrentWs/wsReadyState) while still redacting *socket*/*connection*-named keys and secrets', () => {
  const safe = redactLogValue({
    wsId: 7,
    isCurrentWs: true,
    wsReadyState: 3,
    code: 1006,
    reason: 'STALL_RECOVERY',
    wasClean: false,
    accessToken: 'super-secret-token',
    // The exact key shape the diagnostic fields were renamed AWAY from -- proves this is a
    // key-NAME problem the rename actually fixes, not something the policy stopped enforcing.
    socketId: 7,
    isCurrentSocket: true,
  }) as Record<string, unknown>;
  assert.equal(safe.wsId, 7);
  assert.equal(safe.isCurrentWs, true);
  assert.equal(safe.wsReadyState, 3);
  assert.equal(safe.code, 1006);
  assert.equal(safe.reason, 'STALL_RECOVERY');
  assert.equal(safe.wasClean, false);
  assert.equal(safe.accessToken, '[REDACTED]');
  assert.equal(safe.socketId, '[OMITTED_UNSAFE_OBJECT]');
  assert.equal(safe.isCurrentSocket, '[OMITTED_UNSAFE_OBJECT]');
});

// Exercises the REAL end-to-end winston pipeline (errors -> splat -> redactSecrets -> timestamp ->
// json) via the real singleton logger's own `.format`, not a monkeypatched logger method and not
// redactLogValue in isolation -- proving the diagnostic fields survive all the way to the
// serialized JSON string a transport would actually receive/ship.
test('a real logger.warn-shaped call preserves WebSocket diagnostic scalars through the full winston pipeline', () => {
  const formatted = formatAsProduction('warn', 'Ignoring stale Upstox market data WebSocket error callback', {
    wsId: 3,
    wsReadyState: 3,
    service: 'trademind-backend',
  });
  assert.equal(formatted.wsId, 3);
  assert.equal(formatted.wsReadyState, 3);
  const serialized = (formatted as Record<symbol, unknown>)[MESSAGE] as string;
  assert.equal(typeof serialized, 'string');
  const parsed = JSON.parse(serialized) as Record<string, unknown>;
  assert.equal(parsed.wsId, 3);
  assert.equal(parsed.wsReadyState, 3);
  assert.equal(parsed.message, 'Ignoring stale Upstox market data WebSocket error callback');
});
