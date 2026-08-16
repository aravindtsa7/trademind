import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { ConnectionState } from '../managers/connection.manager';
import MarketDataHealthMonitorService from './market-data-health-monitor.service';

class FakeConnection extends EventEmitter {
  state = ConnectionState.CONNECTED; generation = 1; reconnects = 0;
  getState(): ConnectionState { return this.state; }
  getGenerationId(): number { return this.generation; }
  reconnectForHealth(): void { this.reconnects += 1; this.state = ConnectionState.RECONNECTING; }
}

test('open socket stall starts exactly one controlled reconnect during a market session', () => {
  const connection = new FakeConnection(); let now = 1_000; let stalls = 0;
  const monitor = new MarketDataHealthMonitorService(connection as never, { stallMs: 100, heartbeatCheckMs: 1000, now: () => now, isMarketSession: () => true, onStall: () => { stalls += 1; } });
  connection.emit('connected', { generationId: 1 }); now = 1_101;
  (monitor as any).check(); (monitor as any).check();
  assert.equal(stalls, 1); assert.equal(connection.reconnects, 1);
});

test('stale generation events never refresh the active health heartbeat', () => {
  const connection = new FakeConnection(); let now = 0;
  const monitor = new MarketDataHealthMonitorService(connection as never, { now: () => now });
  connection.emit('connected', { generationId: 2 }); now = 10; monitor.noteValidMarketEvent(1);
  assert.equal(monitor.getSnapshot().lastValidMarketEventAgeMs, null);
  monitor.noteValidMarketEvent(2); now = 20;
  assert.equal(monitor.getSnapshot().lastValidMarketEventAgeMs, 10);
});
