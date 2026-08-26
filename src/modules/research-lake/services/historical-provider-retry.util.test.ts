import assert from 'node:assert/strict';
import test from 'node:test';
import {
  HistoricalProviderPermanentError,
  HistoricalProviderRetryExhaustedError,
  HistoricalProviderRetryStats,
  withHistoricalProviderRetry,
} from './historical-provider-retry.util';

const SECRET_TOKEN = 'super-secret-upstox-bearer-token-value';

function freshStats(): HistoricalProviderRetryStats {
  return { retryCount: 0, rateLimitBackoffCount: 0 };
}

function axiosError(status: number, headers: Record<string, string> = {}): unknown {
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    isAxiosError: true,
    response: { status, headers },
    // A real AxiosError carries the outbound request config, including
    // Authorization headers, on `.config` -- never on `.response`.
    config: { headers: { Authorization: `Bearer ${SECRET_TOKEN}` } },
  });
}

function networkError(): unknown {
  return Object.assign(new Error('timeout of 10000ms exceeded'), {
    isAxiosError: true,
    code: 'ECONNABORTED',
    // no `response` at all -- no response was ever received
    config: { headers: { Authorization: `Bearer ${SECRET_TOKEN}` } },
  });
}

function recordedSleeps(): { sleep: (ms: number) => Promise<void>; calls: number[] } {
  const calls: number[] = [];
  return { sleep: async (ms: number) => { calls.push(ms); }, calls };
}

test('a transient 5xx error is retried and eventually succeeds within the bound', async () => {
  const stats = freshStats();
  const { sleep } = recordedSleeps();
  let attempts = 0;
  const result = await withHistoricalProviderRetry(
    async () => {
      attempts += 1;
      if (attempts < 3) throw axiosError(503);
      return 'ok';
    },
    stats,
    { maxAttempts: 5, sleep, randomJitter: () => 0.5 }
  );

  assert.equal(result, 'ok');
  assert.equal(attempts, 3);
  assert.equal(stats.retryCount, 2);
  assert.equal(stats.rateLimitBackoffCount, 0);
});

test('a network-level failure (no response) is treated as transient and retried', async () => {
  const stats = freshStats();
  const { sleep } = recordedSleeps();
  let attempts = 0;
  const result = await withHistoricalProviderRetry(
    async () => {
      attempts += 1;
      if (attempts < 2) throw networkError();
      return 'ok';
    },
    stats,
    { sleep, randomJitter: () => 0.5 }
  );

  assert.equal(result, 'ok');
  assert.equal(stats.retryCount, 1);
});

test('a 429 with Retry-After obeys the header delay exactly, not the exponential backoff', async () => {
  const stats = freshStats();
  const { sleep, calls } = recordedSleeps();
  let attempts = 0;
  const result = await withHistoricalProviderRetry(
    async () => {
      attempts += 1;
      if (attempts < 2) throw axiosError(429, { 'retry-after': '7' });
      return 'ok';
    },
    stats,
    { sleep, randomJitter: () => 0 }
  );

  assert.equal(result, 'ok');
  assert.deepEqual(calls, [7_000]);
  assert.equal(stats.rateLimitBackoffCount, 1);
  assert.equal(stats.retryCount, 1);
});

test('a 429 with no Retry-After header falls back to bounded exponential backoff', async () => {
  const stats = freshStats();
  const { sleep, calls } = recordedSleeps();
  let attempts = 0;
  await withHistoricalProviderRetry(
    async () => {
      attempts += 1;
      if (attempts < 2) throw axiosError(429);
      return 'ok';
    },
    stats,
    { sleep, baseDelayMs: 500, maxDelayMs: 8_000, randomJitter: () => 1 }
  );

  assert.deepEqual(calls, [500]); // attempt 1 -> base delay at full jitter ceiling
  assert.equal(stats.rateLimitBackoffCount, 1);
});

test('backoff delay is bounded by maxDelayMs even after many attempts', async () => {
  const stats = freshStats();
  const { sleep, calls } = recordedSleeps();
  let attempts = 0;
  await withHistoricalProviderRetry(
    async () => {
      attempts += 1;
      if (attempts < 5) throw axiosError(503);
      return 'ok';
    },
    stats,
    { maxAttempts: 6, sleep, baseDelayMs: 500, maxDelayMs: 2_000, randomJitter: () => 1 }
  );

  assert.ok(calls.every((delay) => delay <= 2_000));
});

test('a permanent 401 fails closed after exactly one attempt, never retried', async () => {
  const stats = freshStats();
  const { sleep } = recordedSleeps();
  let attempts = 0;

  await assert.rejects(
    withHistoricalProviderRetry(
      async () => {
        attempts += 1;
        throw axiosError(401);
      },
      stats,
      { sleep }
    ),
    HistoricalProviderPermanentError
  );

  assert.equal(attempts, 1);
  assert.equal(stats.retryCount, 0);
});

test('a permanent 403 fails closed after exactly one attempt, never retried', async () => {
  const stats = freshStats();
  let attempts = 0;
  await assert.rejects(
    withHistoricalProviderRetry(async () => { attempts += 1; throw axiosError(403); }, stats, { sleep: recordedSleeps().sleep }),
    HistoricalProviderPermanentError
  );
  assert.equal(attempts, 1);
});

test('a permanent non-429 4xx (e.g. 400) fails closed after exactly one attempt', async () => {
  const stats = freshStats();
  let attempts = 0;
  await assert.rejects(
    withHistoricalProviderRetry(async () => { attempts += 1; throw axiosError(400); }, stats, { sleep: recordedSleeps().sleep }),
    HistoricalProviderPermanentError
  );
  assert.equal(attempts, 1);
});

test('a non-axios validation error (malformed response the client itself rejected) is treated as permanent', async () => {
  const stats = freshStats();
  let attempts = 0;
  await assert.rejects(
    withHistoricalProviderRetry(
      async () => {
        attempts += 1;
        throw new Error('Upstox historical candle row contains invalid values.');
      },
      stats,
      { sleep: recordedSleeps().sleep }
    ),
    HistoricalProviderPermanentError
  );
  assert.equal(attempts, 1);
});

test('retry exhaustion on a persistently transient error returns a typed HistoricalProviderRetryExhaustedError', async () => {
  const stats = freshStats();
  const { sleep } = recordedSleeps();
  let attempts = 0;

  await assert.rejects(
    withHistoricalProviderRetry(
      async () => {
        attempts += 1;
        throw axiosError(503);
      },
      stats,
      { maxAttempts: 4, sleep, randomJitter: () => 0.5 }
    ),
    (error: unknown) => {
      assert.ok(error instanceof HistoricalProviderRetryExhaustedError);
      assert.equal(error.attempts, 4);
      return true;
    }
  );

  assert.equal(attempts, 4);
  assert.equal(stats.retryCount, 3);
});

test('SECURITY: no bearer token ever appears in a thrown error message, for either permanent or exhausted failures', async () => {
  const stats = freshStats();
  const { sleep } = recordedSleeps();

  let permanentMessage = '';
  try {
    await withHistoricalProviderRetry(async () => { throw axiosError(401); }, stats, { sleep });
  } catch (error) {
    permanentMessage = error instanceof Error ? error.message : String(error);
  }
  assert.ok(!permanentMessage.includes(SECRET_TOKEN));

  let exhaustedMessage = '';
  try {
    await withHistoricalProviderRetry(async () => { throw axiosError(503); }, stats, { maxAttempts: 2, sleep, randomJitter: () => 0.5 });
  } catch (error) {
    exhaustedMessage = error instanceof Error ? error.message : String(error);
  }
  assert.ok(!exhaustedMessage.includes(SECRET_TOKEN));
});
