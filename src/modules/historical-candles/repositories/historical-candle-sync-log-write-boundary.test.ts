import assert from 'node:assert/strict';
import test from 'node:test';
import { PrismaClient } from '@prisma/client';
import HistoricalCandleRepository from './historical-candle.repository';

const REAL_INCIDENT_MESSAGE =
  'Historical candle session for 2026-08-21 remains incomplete after ' +
  'reconciliation fetch and persistence (rowCount=283, expected 375 ' +
  'complete/contiguous/minute-aligned rows for 09:15-15:29 IST).';

interface PrismaCall {
  method: 'create' | 'update';
  data: Record<string, unknown>;
}

function fakePrismaClient(calls: PrismaCall[]): PrismaClient {
  return {
    historicalCandleSyncLog: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        calls.push({ method: 'create', data });
        return { id: 'log-1', ...data };
      },
      update: async ({ data }: { where: unknown; data: Record<string, unknown> }) => {
        calls.push({ method: 'update', data });
        return { id: 'log-1', ...data };
      },
    },
  } as unknown as PrismaClient;
}

// Proves the fix is actually wired into the repository's real write path
// (not just correct as an isolated pure function): the exact object handed
// to the Prisma client for createSyncLog/updateSyncLog must already carry
// the normalized errorMessage.

test('createSyncLog normalizes an over-length errorMessage before it ever reaches Prisma', async () => {
  const calls: PrismaCall[] = [];
  const repository = new HistoricalCandleRepository(fakePrismaClient(calls));

  await repository.createSyncLog({
    instrumentKey: 'NSE_INDEX|Nifty 50',
    timeframe: '1minute',
    startedAt: new Date(),
    status: 'FAILED',
    errorMessage: REAL_INCIDENT_MESSAGE,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'create');
  assert.equal(typeof calls[0].data.errorMessage, 'string');
  assert.ok((calls[0].data.errorMessage as string).length <= 191);
});

test('updateSyncLog normalizes an over-length errorMessage (the real 2026-08-21 shape) before it reaches Prisma', async () => {
  const calls: PrismaCall[] = [];
  const repository = new HistoricalCandleRepository(fakePrismaClient(calls));

  await repository.updateSyncLog('log-1', {
    completedAt: new Date(),
    status: 'FAILED',
    errorMessage: REAL_INCIDENT_MESSAGE,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'update');
  const written = calls[0].data.errorMessage as string;
  assert.ok(written.length <= 191, `written errorMessage length was ${written.length}, expected <= 191`);
  assert.equal(calls[0].data.status, 'FAILED');
});

test('updateSyncLog leaves a short errorMessage unchanged', async () => {
  const calls: PrismaCall[] = [];
  const repository = new HistoricalCandleRepository(fakePrismaClient(calls));

  await repository.updateSyncLog('log-1', { status: 'FAILED', errorMessage: 'short failure' });

  assert.equal(calls[0].data.errorMessage, 'short failure');
});

test('the COMPLETED success path never carries an errorMessage key and is unaffected by normalization', async () => {
  const calls: PrismaCall[] = [];
  const repository = new HistoricalCandleRepository(fakePrismaClient(calls));

  await repository.updateSyncLog('log-1', {
    completedAt: new Date(),
    downloaded: 375,
    inserted: 375,
    updated: 0,
    durationMs: 42,
    status: 'COMPLETED',
  });

  assert.equal(calls.length, 1);
  assert.equal('errorMessage' in calls[0].data, false);
  assert.equal(calls[0].data.status, 'COMPLETED');
});
