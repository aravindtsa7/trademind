import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import MarketReplayRecorderService, { replayEventId, stableReplayJson } from './market-replay-recorder.service';

test('append-only recorder uses deterministic IDs and suppresses a repeated raw packet', () => {
  const directory = mkdtempSync(join(tmpdir(), 'trademind-replay-'));
  const path = join(directory, 'events.jsonl');
  const recorder = new MarketReplayRecorderService(path, 'v12', '2026-08-17');
  const input = { instrumentKey: 'NSE_INDEX|Nifty 50', sourceTimestamp: '2026-08-17T03:45:00.000Z', receivedTimestamp: '2026-08-17T03:45:01.000Z', sequenceNumber: null, connectionGenerationId: 1, payload: { ltp: 25000 } };
  recorder.record('TICK', input);
  recorder.record('TICK', { ...input, receivedTimestamp: '2026-08-17T03:45:02.000Z' });
  const rows = readFileSync(path, 'utf8').trim().split(/\r?\n/);
  assert.equal(rows.length, 1);
  assert.equal(JSON.parse(rows[0]).eventId, replayEventId({ schemaVersion: 1, eventType: 'TICK', runtimeId: 'v12', sessionId: '2026-08-17', ...input }));
  assert.equal(stableReplayJson({ z: 1, a: { q: 2, b: 1 } }), '{"a":{"b":1,"q":2},"z":1}');
});

test('recorder redacts credentials before append-only persistence', () => {
  const directory = mkdtempSync(join(tmpdir(), 'trademind-replay-'));
  const path = join(directory, 'events.jsonl');
  const recorder = new MarketReplayRecorderService(path, 'v2', '2026-08-17');
  recorder.record('DISCONNECT', { instrumentKey: null, sourceTimestamp: null, receivedTimestamp: '2026-08-17T03:45:01.000Z', sequenceNumber: null, connectionGenerationId: 1, payload: { Authorization: 'Bearer very-secret-token', nested: { accessToken: 'hidden', message: 'Bearer second-token' } } });
  const stored = readFileSync(path, 'utf8');
  assert.ok(!stored.includes('very-secret-token'));
  assert.ok(!stored.includes('second-token'));
  assert.ok(stored.includes('[REDACTED]'));
});
