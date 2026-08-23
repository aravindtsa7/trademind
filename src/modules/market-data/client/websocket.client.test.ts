import assert from 'node:assert/strict';
import test from 'node:test';
import MarketDataWebSocketClient, {
  MarketDataWebSocketClientOptions,
  MarketDataWebSocketClientScheduler,
  MarketDataWebSocketOpenTimeoutError,
} from './websocket.client';
import ConnectionManager, { ConnectionState } from '../managers/connection.manager';

type Listener = (event: never) => void;

class FakeWebSocket {
  static readonly OPEN = 1;
  static instances: FakeWebSocket[] = [];
  static deferClose = false;
  readyState = 0;
  binaryType = '';
  private closed = false;
  private closeEmitted = false;
  private readonly listeners = new Map<string, Listener[]>();

  constructor(_url: string) { FakeWebSocket.instances.push(this); }
  addEventListener(type: string, listener: Listener): void { const values=this.listeners.get(type)??[];values.push(listener);this.listeners.set(type,values); }
  send(): void {}
  close(): void { if(this.closed)return;this.closed=true;this.readyState=3;if(!FakeWebSocket.deferClose)this.finishClose(); }
  finishClose(): void { if(this.closeEmitted)return;this.closeEmitted=true;this.fire('close',{code:1000,reason:'closed',wasClean:true}); }
  open(): void { this.readyState=FakeWebSocket.OPEN;this.fire('open',{}); }
  fail(): void { this.fire('error',{}); }
  private fire(type:string,event:unknown):void{for(const listener of this.listeners.get(type)??[])listener(event as never);}
}

class FakeScheduler implements MarketDataWebSocketClientScheduler {
  now = 0;
  private nextId = 0;
  private readonly active = new Map<number, { at: number; callback: () => void }>();

  setTimeout(callback: () => void, delayMs: number): number {
    const id = this.nextId++;
    this.active.set(id, { at: this.now + delayMs, callback });
    return id;
  }

  clearTimeout(handle: unknown): void { this.active.delete(handle as number); }

  advanceBy(milliseconds: number): void {
    const target = this.now + milliseconds;
    let next = [...this.active].sort((a, b) => a[1].at - b[1].at || a[0] - b[0]).find(([, timer]) => timer.at <= target);
    while (next) {
      this.active.delete(next[0]);
      this.now = next[1].at;
      next[1].callback();
      next = [...this.active].sort((a, b) => a[1].at - b[1].at || a[0] - b[0]).find(([, timer]) => timer.at <= target);
    }
    this.now = target;
  }

  get activeCount(): number { return this.active.size; }
}

function client(options: MarketDataWebSocketClientOptions = {}): MarketDataWebSocketClient {
  const value=new MarketDataWebSocketClient('token', options);
  (value as unknown as {axios:{get:()=>Promise<unknown>}}).axios={get:async()=>({data:{data:{authorized_redirect_uri:'wss://test'}}})};
  return value;
}

function resetWebSockets(): void {
  FakeWebSocket.instances=[];
  FakeWebSocket.deferClose=false;
}

async function flush():Promise<void>{await Promise.resolve();await Promise.resolve();}

test('a pre-open intentional disconnect settles and permits a fresh connection',async()=>{
  const original=globalThis.WebSocket;resetWebSockets();globalThis.WebSocket=FakeWebSocket as unknown as typeof WebSocket;
  try{
    const value=client();const first=value.connect();await flush();assert.equal(FakeWebSocket.instances.length,1);value.disconnect();await assert.rejects(first,/cancelled before opening/);
    const second=value.connect();await flush();assert.equal(FakeWebSocket.instances.length,2);FakeWebSocket.instances[1].open();await second;
  }finally{globalThis.WebSocket=original;}
});

test('a stale socket-open callback cannot publish a second connection',async()=>{
  const original=globalThis.WebSocket;resetWebSockets();globalThis.WebSocket=FakeWebSocket as unknown as typeof WebSocket;
  try{
    const value=client();let connected=0;value.on('connected',()=>{connected+=1;});const first=value.connect();await flush();const stale=FakeWebSocket.instances[0];value.disconnect();await assert.rejects(first);
    const second=value.connect();await flush();const current=FakeWebSocket.instances[1];stale.open();assert.equal(connected,0);current.open();await second;assert.equal(connected,1);
  }finally{globalThis.WebSocket=original;}
});

test('a throwing connection-error observer cannot leave connect pending',async()=>{
  const original=globalThis.WebSocket;resetWebSockets();globalThis.WebSocket=FakeWebSocket as unknown as typeof WebSocket;
  try{
    const value=client();value.on('connectionError',()=>{throw new Error('observer failed');});const pending=value.connect();await flush();FakeWebSocket.instances[0].fail();await assert.rejects(pending,/connection failed/);
  }finally{globalThis.WebSocket=original;}
});

test('an intentional close remains socket-local when a fresh connect starts before close delivery',async()=>{
  const original=globalThis.WebSocket;resetWebSockets();globalThis.WebSocket=FakeWebSocket as unknown as typeof WebSocket;
  try{
    const value=client();const disconnects:Array<{intentional?:boolean}>=[];value.on('disconnected',(event)=>disconnects.push(event));
    const first=value.connect();await flush();const oldSocket=FakeWebSocket.instances[0];oldSocket.open();await first;
    FakeWebSocket.deferClose=true;value.disconnect();const second=value.connect();await flush();const newSocket=FakeWebSocket.instances[1];oldSocket.finishClose();
    assert.equal(disconnects.length,1);assert.equal(disconnects[0].intentional,true);newSocket.open();await second;
  }finally{globalThis.WebSocket=original;}
});

test('a first-ever silent WebSocket handshake times out and settles without receipt-time fallback',async()=>{
  const original=globalThis.WebSocket;resetWebSockets();globalThis.WebSocket=FakeWebSocket as unknown as typeof WebSocket;
  try{
    const scheduler=new FakeScheduler();const value=client({openHandshakeTimeoutMs:25,scheduler});const pending=value.connect();await flush();const socket=FakeWebSocket.instances[0];
    assert.equal(scheduler.activeCount,1);scheduler.advanceBy(24);await flush();assert.equal(socket.readyState,0);
    scheduler.advanceBy(1);await assert.rejects(pending,(error:unknown)=>error instanceof MarketDataWebSocketOpenTimeoutError&&error.code==='WEBSOCKET_OPEN_TIMEOUT');
    assert.equal(socket.readyState,3);assert.equal(scheduler.activeCount,0);
  }finally{globalThis.WebSocket=original;}
});

test('an accepted socket open retires its handshake deadline without creating a failure',async()=>{
  const original=globalThis.WebSocket;resetWebSockets();globalThis.WebSocket=FakeWebSocket as unknown as typeof WebSocket;
  try{
    const scheduler=new FakeScheduler();const value=client({openHandshakeTimeoutMs:25,scheduler});let connected=0;value.on('connected',()=>{connected+=1;});const pending=value.connect();await flush();
    scheduler.advanceBy(24);FakeWebSocket.instances[0].open();await pending;assert.equal(connected,1);assert.equal(scheduler.activeCount,0);scheduler.advanceBy(1_000);assert.equal(connected,1);
  }finally{globalThis.WebSocket=original;}
});

test('late open, error, and close callbacks from a timed-out socket remain quarantined',async()=>{
  const original=globalThis.WebSocket;resetWebSockets();FakeWebSocket.deferClose=true;globalThis.WebSocket=FakeWebSocket as unknown as typeof WebSocket;
  try{
    const scheduler=new FakeScheduler();const value=client({openHandshakeTimeoutMs:25,scheduler});let connected=0;let errors=0;const disconnects:Array<{intentional?:boolean}> = [];
    value.on('connected',()=>{connected+=1;});value.on('connectionError',()=>{errors+=1;});value.on('disconnected',(event)=>disconnects.push(event));
    const pending=value.connect();await flush();const stale=FakeWebSocket.instances[0];scheduler.advanceBy(25);await assert.rejects(pending,/did not open/);
    stale.open();stale.fail();stale.finishClose();assert.equal(connected,0);assert.equal(errors,0);assert.deepEqual(disconnects,[{code:1000,reason:'closed',wasClean:true,intentional:true}]);
  }finally{globalThis.WebSocket=original;}
});

test('the real client timeout enters ConnectionManager recovery without a stale socket generation',async()=>{
  const original=globalThis.WebSocket;resetWebSockets();FakeWebSocket.deferClose=true;globalThis.WebSocket=FakeWebSocket as unknown as typeof WebSocket;
  try{
    const scheduler=new FakeScheduler();const value=client({openHandshakeTimeoutMs:25,scheduler});const manager=new ConnectionManager('token',value,{maximumReconnectAttempts:3,maximumReconnectDurationMs:1_000,reconnectJitterMs:0,initialReconnectDelayMs:10,maximumReconnectDelayMs:40,now:()=>scheduler.now,scheduler});
    const pending=manager.connect();await flush();const stale=FakeWebSocket.instances[0];scheduler.advanceBy(25);await assert.rejects(pending,/did not open/);await flush();
    assert.equal(manager.getState(),ConnectionState.RECONNECTING);assert.equal(manager.getGenerationId(),0);assert.equal(manager.getReconnectCircuitSnapshot().attempts,1);
    stale.open();stale.fail();stale.finishClose();assert.equal(manager.getState(),ConnectionState.RECONNECTING);assert.equal(manager.getGenerationId(),0);assert.equal(manager.getReconnectCircuitSnapshot().attempts,1);
    manager.disconnect();
  }finally{globalThis.WebSocket=original;}
});

test('invalid WebSocket open timeout configuration fails closed',()=>{
  assert.throws(()=>client({openHandshakeTimeoutMs:Number.NaN}),/positive finite/);
  assert.throws(()=>client({openHandshakeTimeoutMs:0}),/positive finite/);
});

// TEST-ONLY ACCEPTANCE GAP: the pre-socket authorization REST request (Upstox's
// market-data-feed/authorize call) must fail closed -- on rejection/timeout and
// on a malformed response -- without ever opening a WebSocket.
test('a rejected/timed-out authorization request fails closed before any socket is created',async()=>{
  const original=globalThis.WebSocket;resetWebSockets();globalThis.WebSocket=FakeWebSocket as unknown as typeof WebSocket;
  try{
    const value=new MarketDataWebSocketClient('token');
    (value as unknown as {axios:{get:()=>Promise<unknown>}}).axios={get:async()=>{throw new Error('AUTHORIZE_REQUEST_TIMEOUT');}};
    await assert.rejects(()=>value.connect(),/AUTHORIZE_REQUEST_TIMEOUT/);
    assert.equal(FakeWebSocket.instances.length,0); // no socket is ever opened from a rejected authorization request
  }finally{globalThis.WebSocket=original;}
});

test('an authorization response missing the redirect URI fails closed before any socket is created',async()=>{
  const original=globalThis.WebSocket;resetWebSockets();globalThis.WebSocket=FakeWebSocket as unknown as typeof WebSocket;
  try{
    const value=new MarketDataWebSocketClient('token');
    (value as unknown as {axios:{get:()=>Promise<unknown>}}).axios={get:async()=>({data:{}})};
    await assert.rejects(()=>value.connect(),/did not return an authorized/);
    assert.equal(FakeWebSocket.instances.length,0);
  }finally{globalThis.WebSocket=original;}
});

test('an authorization rejection routes through ConnectionManager recovery without ever creating a socket generation',async()=>{
  const original=globalThis.WebSocket;resetWebSockets();globalThis.WebSocket=FakeWebSocket as unknown as typeof WebSocket;
  try{
    const value=new MarketDataWebSocketClient('token');
    (value as unknown as {axios:{get:()=>Promise<unknown>}}).axios={get:async()=>{throw new Error('AUTHORIZE_REQUEST_TIMEOUT');}};
    const manager=new ConnectionManager('token',value,{maximumReconnectAttempts:3,maximumReconnectDurationMs:1_000,reconnectJitterMs:0,initialReconnectDelayMs:10,maximumReconnectDelayMs:40});
    await assert.rejects(()=>manager.connect(),/AUTHORIZE_REQUEST_TIMEOUT/);
    assert.equal(manager.getState(),ConnectionState.RECONNECTING);
    assert.equal(manager.getGenerationId(),0); // authorization never reached a socket, so no generation was ever assigned
    assert.equal(manager.getReconnectCircuitSnapshot().attempts,1);
    assert.equal(FakeWebSocket.instances.length,0);
    manager.disconnect();
  }finally{globalThis.WebSocket=original;}
});
