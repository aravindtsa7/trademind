import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import SubscriptionManager from './subscription.manager';
import { ConnectionState } from './connection.manager';

class FakeConnection extends EventEmitter {
  state = ConnectionState.CONNECTED;
  sent = 0;
  async connect(): Promise<void> {}
  getState(): ConnectionState { return this.state; }
  send(): void { this.sent += 1; }
}

test('retained NIFTY and option subscriptions restore once after reconnect', async () => {
  const connection = new FakeConnection();
  const subscriptions = new SubscriptionManager('token', connection as never);
  await subscriptions.subscribe('NSE_INDEX|Nifty 50');
  await subscriptions.subscribe('NSE_FO|123|01-01-2027');
  assert.equal(connection.sent, 2);
  connection.emit('stateChanged', { previousState: ConnectionState.RECONNECTING, state: ConnectionState.CONNECTED });
  assert.equal(connection.sent, 3);
  connection.emit('stateChanged', { previousState: ConnectionState.CONNECTED, state: ConnectionState.CONNECTED });
  assert.equal(connection.sent, 3);
  assert.equal(subscriptions.getSubscriptions().length, 2);
});
