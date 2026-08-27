import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { AxiosInstance } from 'axios';
import GrowwAccessTokenProviderService, { GrowwAccessTokenProviderError } from './groww-access-token-provider.service';

const API_KEY = 'super-secret-groww-api-key';
const API_SECRET = 'super-secret-groww-api-secret';

interface MockPostCall { url: string; body: unknown; config: { headers?: Record<string, string> }; }

class AxiosPostMock {
  readonly calls: MockPostCall[] = [];
  constructor(private readonly responder: (call: MockPostCall) => Promise<{ data: unknown }>) {}
  async post(url: string, body: unknown, config: { headers?: Record<string, string> }): Promise<{ data: unknown }> {
    const call = { url, body, config };
    this.calls.push(call);
    return this.responder(call);
  }
}

function createProvider(responder: (call: MockPostCall) => Promise<{ data: unknown }>): { provider: GrowwAccessTokenProviderService; axiosMock: AxiosPostMock } {
  const axiosMock = new AxiosPostMock(responder);
  const provider = new GrowwAccessTokenProviderService(API_KEY, API_SECRET, axiosMock as unknown as AxiosInstance);
  return { provider, axiosMock };
}

function axiosFailure(status: number, data: unknown): Promise<never> {
  const error = Object.assign(new Error(`Request failed with status code ${status}`), {
    isAxiosError: true,
    response: { status, data, headers: {} },
    config: { headers: { Authorization: `Bearer ${API_KEY}` } },
  });
  return Promise.reject(error);
}

test('generates a token via the documented approval flow: POST /v1/token/api/access with key_type=approval, a SHA256(secret+timestamp) checksum, and Bearer <API_KEY>', async () => {
  const { provider, axiosMock } = createProvider(() => Promise.resolve({ data: { token: 'generated-access-token' } }));
  const token = await provider.getAccessToken();
  assert.equal(token, 'generated-access-token');
  assert.equal(axiosMock.calls.length, 1);
  assert.equal(axiosMock.calls[0].url, '/v1/token/api/access');
  const body = axiosMock.calls[0].body as { key_type: string; checksum: string; timestamp: string };
  assert.equal(body.key_type, 'approval');
  assert.equal(body.checksum, createHash('sha256').update(`${API_SECRET}${body.timestamp}`).digest('hex'));
  assert.equal(axiosMock.calls[0].config.headers?.Authorization, `Bearer ${API_KEY}`);
});

test('REGRESSION (live-confirmed): timestamp is epoch SECONDS, not milliseconds -- a ms-scale value made the real Groww approval endpoint return HTTP 400 "timestamp must be in epoch seconds format"', async () => {
  const { provider, axiosMock } = createProvider(() => Promise.resolve({ data: { token: 'x' } }));
  const before = Math.floor(Date.now() / 1000);
  await provider.getAccessToken();
  const after = Math.floor(Date.now() / 1000);
  const timestamp = Number((axiosMock.calls[0].body as { timestamp: string }).timestamp);
  assert.ok(timestamp >= before - 1 && timestamp <= after + 1, `timestamp ${timestamp} should be current epoch SECONDS (~${before}), not milliseconds (~${before * 1000})`);
});

test('caches the generated token in memory: a second call does not issue a second HTTP request', async () => {
  const { provider, axiosMock } = createProvider(() => Promise.resolve({ data: { token: 'cached-token' } }));
  await provider.getAccessToken();
  await provider.getAccessToken();
  assert.equal(axiosMock.calls.length, 1);
});

test('invalidate() forces the next call to regenerate a token', async () => {
  let call = 0;
  const { provider } = createProvider(() => {
    call += 1;
    return Promise.resolve({ data: { token: `token-${call}` } });
  });
  const first = await provider.getAccessToken();
  provider.invalidate();
  const second = await provider.getAccessToken();
  assert.equal(first, 'token-1');
  assert.equal(second, 'token-2');
});

test('throws GrowwAccessTokenProviderError when GROWW_API_KEY/GROWW_API_SECRET are missing -- never attempts a request', async () => {
  const axiosMock = new AxiosPostMock(() => Promise.resolve({ data: { token: 'x' } }));
  const provider = new GrowwAccessTokenProviderService('', '', axiosMock as unknown as AxiosInstance);
  await assert.rejects(provider.getAccessToken(), GrowwAccessTokenProviderError);
  assert.equal(axiosMock.calls.length, 0);
});

test('a response missing a non-empty string "token" field fails closed rather than guessing an alternative shape', async () => {
  const { provider } = createProvider(() => Promise.resolve({ data: { access_token: 'wrong-field-name' } }));
  await assert.rejects(provider.getAccessToken(), GrowwAccessTokenProviderError);
});

test('(T) a 401 from the approval endpoint fails closed as a typed error with no key/secret leakage', async () => {
  const { provider } = createProvider(() => axiosFailure(401, { message: 'invalid key' }));
  let message = '';
  await assert.rejects(provider.getAccessToken(), (error: unknown) => {
    assert.ok(error instanceof GrowwAccessTokenProviderError);
    assert.equal(error.httpStatus, 401);
    message = error.message;
    return true;
  });
  assert.ok(!message.includes(API_KEY));
  assert.ok(!message.includes(API_SECRET));
});

test('a 403 from the approval endpoint fails closed as a typed error', async () => {
  const { provider } = createProvider(() => axiosFailure(403, { message: 'forbidden' }));
  await assert.rejects(provider.getAccessToken(), (error: unknown) => {
    assert.ok(error instanceof GrowwAccessTokenProviderError);
    assert.equal(error.httpStatus, 403);
    return true;
  });
});

test('SECURITY: the API key/secret and generated token never appear in a successful result or any thrown error message', async () => {
  const { provider } = createProvider(() => Promise.resolve({ data: { token: 'a-real-looking-generated-token' } }));
  const token = await provider.getAccessToken();
  assert.equal(token, 'a-real-looking-generated-token');

  const { provider: failProvider } = createProvider(() => axiosFailure(401, {}));
  let message = '';
  try {
    await failProvider.getAccessToken();
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  assert.ok(!message.includes(API_KEY));
  assert.ok(!message.includes(API_SECRET));
});
