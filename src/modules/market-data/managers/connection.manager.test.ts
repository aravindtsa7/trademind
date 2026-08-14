import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import ConnectionManager, { ConnectionState } from './connection.manager';

class FakeClient extends EventEmitter {
  connects = 0;
  failures = 0;
  async connect(): Promise<void> {
    this.connects += 1;
    if (this.failures > 0) {
      this.failures -= 1;
      throw new Error('connect failed');
    }
    this.emit('connected');
  }
  disconnect(): void { this.emit('disconnected', { code: 1000 }, true); }
  send(): void {}
}

const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

test('unexpected 1006 disconnect reconnects and emits one recovery event', async () => {
  const client = new FakeClient();
  const manager = new ConnectionManager('token', client as never, { maximumReconnectAttempts: 3, maximumReconnectDurationMs: 500 });
  let reconnects = 0;
  manager.on('reconnected', () => { reconnects += 1; });
  await manager.connect();
  client.emit('disconnected', { code: 1006, reason: 'stale socket' }, false);
  await wait(20);
  assert.equal(client.connects, 1);
  client.emit('disconnected', { code: 1006, reason: '' }, true);
  await wait(1_100);
  assert.equal(manager.getState(), ConnectionState.CONNECTED);
  assert.equal(reconnects, 1);
  assert.equal(client.connects, 2);
});

test('intentional disconnect does not schedule a reconnect', async () => {
  const client = new FakeClient();
  const manager = new ConnectionManager('token', client as never, { maximumReconnectAttempts: 1, maximumReconnectDurationMs: 100 });
  await manager.connect();
  manager.disconnect();
  await wait(1_100);
  assert.equal(manager.getState(), ConnectionState.DISCONNECTED);
  assert.equal(client.connects, 1);
});

test('duplicate close/error callbacks create one reconnect episode, while intentional close creates none', async () => {
  const client = new FakeClient();
  const manager = new ConnectionManager('token', client as never, { maximumReconnectAttempts: 2, maximumReconnectDurationMs: 5_000 });
  let disconnects = 0; let reconnectFailures = 0;
  manager.on('unexpectedDisconnect', () => { disconnects += 1; }); manager.on('reconnectFailed', () => { reconnectFailures += 1; });
  await manager.connect();
  client.emit('disconnected', { code: 1006 }, true); client.emit('connectionError', new Error('late socket error')); client.emit('disconnected', { code: 1006 }, true);
  await wait(20); assert.equal(disconnects, 1);
  await wait(1_100); assert.equal(manager.getState(), ConnectionState.CONNECTED);
  manager.disconnect(); client.emit('connectionError', new Error('expected after close')); client.emit('disconnected', { code: 1006 }, true);
  await wait(20); assert.equal(reconnectFailures, 0); assert.equal(manager.getState(), ConnectionState.DISCONNECTED);
});

test('reconnect attempts fail closed within configured bounds', async () => {
  const client = new FakeClient();
  client.failures = 10;
  const manager = new ConnectionManager('token', client as never, { maximumReconnectAttempts: 2, maximumReconnectDurationMs: 2_500 });
  let failed = 0;
  manager.on('reconnectFailed', () => { failed += 1; });
  await assert.rejects(manager.connect());
  await wait(3_500);
  assert.equal(manager.getState(), ConnectionState.DISCONNECTED);
  assert.equal(failed, 1);
});
