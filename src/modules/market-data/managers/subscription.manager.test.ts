import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import SubscriptionManager from './subscription.manager';
import { ConnectionState } from './connection.manager';
import { MarketDataWebSocketOpenTimeoutError } from '../client/websocket.client';

class FakeConnection extends EventEmitter {
  state = ConnectionState.CONNECTED;
  sent = 0;
  generation = 1;
  async connect(): Promise<void> {}
  getState(): ConnectionState { return this.state; }
  getGenerationId(): number { return this.generation; }
  send(): void { this.sent += 1; }
}

class TimedOutInitialConnection extends FakeConnection {
  override state = ConnectionState.DISCONNECTED;
  connectCalls = 0;

  override async connect(): Promise<void> {
    this.connectCalls += 1;
    this.state = ConnectionState.RECONNECTING;
    throw new MarketDataWebSocketOpenTimeoutError(25);
  }
}

test('retained NIFTY and option subscriptions restore once after reconnect', async () => {
  const connection = new FakeConnection();
  const subscriptions = new SubscriptionManager('token', connection as never);
  await subscriptions.subscribe('NSE_INDEX|Nifty 50');
  await subscriptions.subscribe('NSE_FO|123|01-01-2027');
  assert.equal(connection.sent, 2);
  connection.generation = 2;
  connection.emit('stateChanged', { previousState: ConnectionState.RECONNECTING, state: ConnectionState.CONNECTED, generationId: 2 });
  assert.equal(connection.sent, 3);
  connection.emit('stateChanged', { previousState: ConnectionState.CONNECTED, state: ConnectionState.CONNECTED, generationId: 2 });
  assert.equal(connection.sent, 3);
  assert.equal(subscriptions.getSubscriptions().length, 2);
});

test('subscription startup returns after a bounded initial handshake failure and retains reconnect intent',async()=>{
  const connection=new TimedOutInitialConnection();const subscriptions=new SubscriptionManager('token',connection as never);
  await subscriptions.subscribe('NSE_INDEX|Nifty 50');
  assert.equal(connection.connectCalls,1);assert.equal(connection.getState(),ConnectionState.RECONNECTING);assert.deepEqual(subscriptions.getSubscriptions(),[{instrumentKey:'NSE_INDEX|Nifty 50',mode:'full'}]);assert.equal(connection.sent,0);
});

/** F-04 (SubscriptionManager terminal-failure rollback): connect() rejects while the connection
 * is NOT left owning a reconnect episode -- unlike TimedOutInitialConnection above, which is the
 * legitimate RECONNECTING-owned-intent case this rollback must never touch. */
class OnceFailingConnection extends FakeConnection {
  failNext = true;
  override async connect(): Promise<void> {
    if (this.failNext) { this.failNext = false; throw new Error('AUTH_REJECTED'); }
  }
}

test('a terminal (non-reconnect-owned) subscribe failure does not retain a stale subscription that blocks a later retry', async () => {
  const connection = new OnceFailingConnection();
  const subscriptions = new SubscriptionManager('token', connection as never);
  await assert.rejects(() => subscriptions.subscribe('NSE_INDEX|Nifty 50'), /AUTH_REJECTED/);
  // No reconnect episode owns this failure (state never left CONNECTED) -- the intent must not
  // be retained, or a later retry would silently no-op via getNewInstrumentKeys() instead of
  // actually attempting a fresh physical subscribe.
  assert.deepEqual(subscriptions.getSubscriptions(), []);
  await subscriptions.subscribe('NSE_INDEX|Nifty 50');
  assert.equal(connection.sent, 1);
  assert.deepEqual(subscriptions.getSubscriptions(), [{ instrumentKey: 'NSE_INDEX|Nifty 50', mode: 'full' }]);
});

test('a terminal subscribeMany failure only rolls back the keys that call added, never an unrelated already-subscribed key', async () => {
  const connection = new OnceFailingConnection();
  connection.failNext = false;
  const subscriptions = new SubscriptionManager('token', connection as never);
  await subscriptions.subscribe('NSE_INDEX|Nifty 50');
  connection.failNext = true;
  await assert.rejects(() => subscriptions.subscribe('NSE_FO|123|01-01-2027'), /AUTH_REJECTED/);
  assert.deepEqual(subscriptions.getSubscriptions(), [{ instrumentKey: 'NSE_INDEX|Nifty 50', mode: 'full' }]);
});
