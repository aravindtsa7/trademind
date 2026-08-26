import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { ConnectionState, ReconnectCircuitSnapshot } from '../managers/connection.manager';
import MarketDataHealthMonitorService from './market-data-health-monitor.service';
import TickProcessor, { MarketTickEvent } from '../processors/tick.processor';

class FakeConnection extends EventEmitter {
  state = ConnectionState.CONNECTED;
  generation = 1;
  reconnects = 0;
  confirmations = 0;
  attempts = 0;
  lastReason: string | null = null;
  getState(): ConnectionState { return this.state; }
  getGenerationId(): number { return this.generation; }
  reconnectForHealth(reason: string, generationId: number): boolean { if(this.state!==ConnectionState.CONNECTED||generationId!==this.generation)return false;this.reconnects+=1;this.attempts+=1;this.lastReason=reason;this.state=ConnectionState.RECONNECTING;return true; }
  confirmRecoveryReady(generationId: number): boolean { if(this.state!==ConnectionState.CONNECTED||generationId!==this.generation)return false;this.confirmations+=1;this.attempts=0;this.lastReason=null;return true; }
  transportConfirmations = 0;
  confirmTransportReady(generationId: number): boolean { if(this.state!==ConnectionState.CONNECTED||generationId!==this.generation)return false;this.transportConfirmations+=1;this.attempts=0;this.lastReason=null;return true; }
  getReconnectCircuitSnapshot(): ReconnectCircuitSnapshot { return {state:'CLOSED',attempts:this.attempts,lastFailureReason:this.lastReason,activeGenerationId:this.generation,pendingRecoveryGenerationId:null,reconnectEpisodeActive:this.state===ConnectionState.RECONNECTING,nextRetryAtMs:null}; }
}

function setup(): {connection:FakeConnection;monitor:MarketDataHealthMonitorService;setNow:(value:number)=>void} {
  const connection=new FakeConnection();let now=0;const monitor=new MarketDataHealthMonitorService(connection as never,{stallMs:100,generationGraceMs:100,heartbeatCheckMs:1_000,now:()=>now,isMarketSession:()=>true});
  return {connection,monitor,setNow:(value)=>{now=value;}};
}

test('repeated health polls inside generation grace remain recovering and do not reconnect',()=>{
  const {connection,monitor,setNow}=setup();connection.emit('connected',{generationId:1});setNow(99);monitor.checkNow();monitor.checkNow();
  assert.equal(connection.reconnects,0);assert.equal(monitor.isHealthy(),false);assert.equal(monitor.getSnapshot().insideGrace,true);assert.equal(monitor.getSnapshot().healthState,'GRACE');
});

test('current-generation required data and recovery confirmation end grace and reset breaker',()=>{
  const {connection,monitor,setNow}=setup();connection.attempts=2;connection.emit('connected',{generationId:1});setNow(20);connection.emit('message',Buffer.alloc(0),{generationId:1});monitor.noteValidMarketEvent(1);monitor.noteNiftyTick(1);
  assert.equal(monitor.confirmRecoveryReady(1),true);assert.equal(monitor.isHealthy(),true);assert.equal(connection.confirmations,1);assert.equal(connection.attempts,0);assert.equal(monitor.getSnapshot().insideGrace,false);
});

test('grace expiry without sufficient current-generation data triggers one counted recovery',()=>{
  const {connection,monitor,setNow}=setup();let stalls=0;monitor.on('stalled',()=>{stalls+=1;});connection.emit('connected',{generationId:1});setNow(101);monitor.checkNow();monitor.checkNow();
  assert.equal(connection.reconnects,1);assert.equal(connection.attempts,1);assert.equal(stalls,1);assert.equal(monitor.getSnapshot().healthState,'UNHEALTHY');assert.equal(connection.lastReason,'HEALTH_GRACE_EXPIRED');
});

test('raw and valid non-NIFTY traffic cannot falsely complete grace',()=>{
  const {connection,monitor,setNow}=setup();connection.emit('connected',{generationId:1});setNow(10);connection.emit('message',Buffer.alloc(0),{generationId:1});monitor.noteValidMarketEvent(1);
  assert.equal(monitor.confirmRecoveryReady(1),false);setNow(101);monitor.checkNow();assert.equal(connection.reconnects,1);
});

test('fresh traffic cannot extend grace indefinitely without explicit recovery confirmation',()=>{
  const {connection,monitor,setNow}=setup();connection.emit('connected',{generationId:1});setNow(99);connection.emit('message',Buffer.alloc(0),{generationId:1});monitor.noteValidMarketEvent(1);monitor.noteNiftyTick(1);
  setNow(101);monitor.checkNow();assert.equal(connection.reconnects,1);assert.equal(connection.lastReason,'HEALTH_GRACE_EXPIRED');assert.equal(monitor.isHealthy(),false);
});

test('an old generation deadline cannot stall a newer generation',()=>{
  const {connection,monitor,setNow}=setup();connection.emit('connected',{generationId:1});setNow(90);connection.generation=2;connection.emit('connected',{generationId:2});setNow(150);monitor.checkNow();
  assert.equal(connection.reconnects,0);assert.equal(monitor.getSnapshot().generationId,2);assert.equal(monitor.getSnapshot().insideGrace,true);
});

test('a pre-session connection begins grace only when in-session monitoring starts',()=>{
  const connection=new FakeConnection();let now=0;let inSession=false;const monitor=new MarketDataHealthMonitorService(connection as never,{stallMs:100,generationGraceMs:100,now:()=>now,isMarketSession:()=>inSession});
  connection.emit('connected',{generationId:1});connection.emit('message',Buffer.alloc(0),{generationId:1});monitor.noteValidMarketEvent(1);monitor.noteNiftyTick(1);assert.equal(monitor.confirmRecoveryReady(1),false);now=1_000;monitor.checkNow();assert.equal(connection.reconnects,0);assert.equal(monitor.getSnapshot().graceRemainingMs,null);
  inSession=true;monitor.checkNow();assert.equal(monitor.getSnapshot().insideGrace,true);now=1_099;monitor.checkNow();assert.equal(connection.reconnects,0);
});

test('stale generation events never refresh or confirm active health',()=>{
  const {connection,monitor,setNow}=setup();connection.generation=2;connection.emit('connected',{generationId:2});setNow(10);connection.emit('message',Buffer.alloc(0),{generationId:1});monitor.noteValidMarketEvent(1);monitor.noteNiftyTick(1);
  assert.equal(monitor.confirmRecoveryReady(1),false);assert.equal(monitor.getSnapshot().lastRawMessageAgeMs,null);assert.equal(monitor.getSnapshot().lastValidMarketEventAgeMs,null);assert.equal(monitor.getSnapshot().lastNiftyTickAgeMs,null);
});

test('after grace confirmation normal freshness monitoring includes the required NIFTY tick',()=>{
  const {connection,monitor,setNow}=setup();connection.emit('connected',{generationId:1});connection.emit('message',Buffer.alloc(0),{generationId:1});monitor.noteValidMarketEvent(1);monitor.noteNiftyTick(1);assert.equal(monitor.confirmRecoveryReady(1),true);
  setNow(101);connection.emit('message',Buffer.alloc(0),{generationId:1});monitor.noteValidMarketEvent(1);monitor.checkNow();assert.equal(connection.reconnects,1);assert.equal(connection.lastReason,'STALL');
});

// ---- A2: source-time progression stall ----

test('A2-A: packets arrive and sourceTimestamp keeps advancing -- stays healthy',()=>{
  const {connection,monitor,setNow}=setup();connection.emit('connected',{generationId:1});
  connection.emit('message',Buffer.alloc(0),{generationId:1});monitor.noteValidMarketEvent(1);monitor.noteNiftyTick(1,new Date(0));
  assert.equal(monitor.confirmRecoveryReady(1),true);
  for (let step=1;step<=5;step+=1) { setNow(step*80); connection.emit('message',Buffer.alloc(0),{generationId:1}); monitor.noteValidMarketEvent(1); monitor.noteNiftyTick(1,new Date(step*80)); monitor.checkNow(); }
  assert.equal(connection.reconnects,0);assert.equal(monitor.isHealthy(),true);
});

test('A2-B: no packets arrive beyond the stall threshold -- existing receive-stall behavior is unchanged',()=>{
  const {connection,monitor,setNow}=setup();connection.emit('connected',{generationId:1});connection.emit('message',Buffer.alloc(0),{generationId:1});monitor.noteValidMarketEvent(1);monitor.noteNiftyTick(1,new Date(0));assert.equal(monitor.confirmRecoveryReady(1),true);
  setNow(101);monitor.checkNow(); // no further messages/ticks at all
  assert.equal(connection.reconnects,1);assert.equal(connection.lastReason,'STALL');
});

test('A2-C: packets keep arriving but the accepted NIFTY sourceTimestamp never advances -- must not be indistinguishable from healthy',()=>{
  const {connection,monitor,setNow}=setup();connection.emit('connected',{generationId:1});connection.emit('message',Buffer.alloc(0),{generationId:1});monitor.noteValidMarketEvent(1);monitor.noteNiftyTick(1,new Date(0));assert.equal(monitor.confirmRecoveryReady(1),true);
  setNow(101);connection.emit('message',Buffer.alloc(0),{generationId:1});monitor.noteValidMarketEvent(1);monitor.noteNiftyTick(1,new Date(0));monitor.checkNow(); // raw/valid/NIFTY traffic all fresh, but the source timestamp repeats
  assert.equal(connection.reconnects,1);assert.equal(connection.lastReason,'SOURCE_STALL');assert.equal(monitor.getSnapshot().healthState,'UNHEALTHY');
});

test('A2-D: a source timestamp that briefly repeats within the stall threshold does not trigger a false stall',()=>{
  const {connection,monitor,setNow}=setup();connection.emit('connected',{generationId:1});connection.emit('message',Buffer.alloc(0),{generationId:1});monitor.noteValidMarketEvent(1);monitor.noteNiftyTick(1,new Date(0));assert.equal(monitor.confirmRecoveryReady(1),true);
  setNow(50);connection.emit('message',Buffer.alloc(0),{generationId:1});monitor.noteValidMarketEvent(1);monitor.noteNiftyTick(1,new Date(0));monitor.checkNow(); // repeated source timestamp, but well inside the 100ms stall threshold
  assert.equal(connection.reconnects,0);assert.equal(monitor.isHealthy(),true);
});

test('A2-E: source time advancing again after a repeat resumes normal healthy tracking',()=>{
  const {connection,monitor,setNow}=setup();connection.emit('connected',{generationId:1});connection.emit('message',Buffer.alloc(0),{generationId:1});monitor.noteValidMarketEvent(1);monitor.noteNiftyTick(1,new Date(0));assert.equal(monitor.confirmRecoveryReady(1),true);
  setNow(50);connection.emit('message',Buffer.alloc(0),{generationId:1});monitor.noteValidMarketEvent(1);monitor.noteNiftyTick(1,new Date(50));monitor.checkNow(); // source time advanced again before the threshold
  assert.equal(connection.reconnects,0);
  setNow(130);connection.emit('message',Buffer.alloc(0),{generationId:1});monitor.noteValidMarketEvent(1);monitor.noteNiftyTick(1,new Date(130));monitor.checkNow();
  assert.equal(connection.reconnects,0);assert.equal(monitor.isHealthy(),true);
});

test('A2-F: a stale/superseded generation cannot advance source-health state for the current generation',()=>{
  const {connection,monitor,setNow}=setup();connection.generation=2;connection.emit('connected',{generationId:2});setNow(10);
  monitor.noteNiftyTick(1,new Date(9_999)); // old generation -- must be ignored entirely, including for source tracking
  assert.equal(monitor.getSnapshot().lastNiftySourceAdvanceAgeMs,null);
});

// ---- source-classification watchdog (Terra correction) --------------------------------------
// isSourceFresh gates ONLY the narrow SOURCE_STALL classification: raw/transport activity is
// still fresh, but the accepted NIFTY sourceTimestamp itself has stopped advancing because its
// canonical source horizon ended. A dead-open transport (STALL) or an unconfirmed grace period
// (HEALTH_GRACE_EXPIRED) must ALWAYS still solicit a reconnect -- this class exists specifically
// to detect a WebSocket that remains logically CONNECTED but has stopped delivering all
// packets, and option quotes/marking/risk/exit data can still require a working socket up to
// the 15:40 operational EOD, independent of whether NIFTY source candles are still produced.

const NIFTY_SOURCE_COMPLETION_BOUNDARY_MS = Date.UTC(2026, 7, 25, 10, 0, 0); // 2026-08-25T15:30:00+05:30
const POST_SOURCE_COMPLETION_MS = NIFTY_SOURCE_COMPLETION_BOUNDARY_MS + 60_000; // 15:31:00

function setupSourceFreshness(nowMs: number, onStall?: (snapshot: unknown, context: { reason: string; reconnectSolicited: boolean }) => void): { connection: FakeConnection; monitor: MarketDataHealthMonitorService; setNow: (value: number) => void } {
  const connection = new FakeConnection();
  let now = nowMs;
  const monitor = new MarketDataHealthMonitorService(connection as never, {
    stallMs: 100,
    generationGraceMs: 100,
    heartbeatCheckMs: 1_000,
    now: () => now,
    isMarketSession: () => true, // wide operational session (mirrors the 09:15-15:40 default) -- unaffected by isSourceFresh
    isSourceFresh: (value) => value.getTime() < NIFTY_SOURCE_COMPLETION_BOUNDARY_MS,
    onStall: onStall as never,
  });
  return { connection, monitor, setNow: (value) => { now = value; } };
}

test('source-classification A: 15:31 SOURCE_STALL -- raw/transport activity stays fresh, only the NIFTY source timestamp is stale after source completion -- does NOT solicit a health reconnect', () => {
  const { connection, monitor, setNow } = setupSourceFreshness(POST_SOURCE_COMPLETION_MS - 1_000);
  connection.emit('connected', { generationId: 1 });
  connection.emit('message', Buffer.alloc(0), { generationId: 1 }); monitor.noteValidMarketEvent(1); monitor.noteNiftyTick(1, new Date(0));
  assert.equal(monitor.confirmRecoveryReady(1), true);
  setNow(POST_SOURCE_COMPLETION_MS - 1_000 + 101);
  // Raw packets and valid market events keep arriving (transport is alive); the accepted NIFTY
  // source timestamp repeats (the source itself has stopped advancing post-completion).
  connection.emit('message', Buffer.alloc(0), { generationId: 1 }); monitor.noteValidMarketEvent(1); monitor.noteNiftyTick(1, new Date(0));
  monitor.checkNow();
  const snapshot = monitor.getSnapshot();
  assert.ok(snapshot.lastRawMessageAgeMs !== null && snapshot.lastRawMessageAgeMs <= 100, 'transport must genuinely be fresh, proving this is really a SOURCE_STALL classification');
  assert.ok(snapshot.lastNiftySourceAdvanceAgeMs !== null && snapshot.lastNiftySourceAdvanceAgeMs > 100, 'the NIFTY source timestamp must genuinely be stale');
  assert.equal(connection.reconnects, 0, 'a doomed post-source-completion candle-recovery reconnect must never be solicited for a pure SOURCE_STALL');
  assert.equal(snapshot.healthState, 'UNHEALTHY', 'the condition is still detected/reported for observability');
});

test('source-classification B: 15:31 full dead-open transport STALL (raw/valid/NIFTY traffic all stale) -- reconnectForHealth MUST still occur', () => {
  const { connection, monitor, setNow } = setupSourceFreshness(POST_SOURCE_COMPLETION_MS);
  connection.emit('connected', { generationId: 1 });
  connection.emit('message', Buffer.alloc(0), { generationId: 1 }); monitor.noteValidMarketEvent(1); monitor.noteNiftyTick(1);
  assert.equal(monitor.confirmRecoveryReady(1), true);
  setNow(POST_SOURCE_COMPLETION_MS + 101); // no further messages/ticks at all -- a genuinely dead-open transport
  monitor.checkNow();
  assert.equal(connection.reconnects, 1, 'a dead-open transport must still be recovered, independent of source completion');
  assert.equal(connection.lastReason, 'STALL');
});

test('source-classification C: 15:31 HEALTH_GRACE_EXPIRED -- reconnect/recovery behavior remains active', () => {
  const { connection, monitor, setNow } = setupSourceFreshness(POST_SOURCE_COMPLETION_MS);
  connection.emit('connected', { generationId: 1 }); // never confirmed/ticked before grace expires
  setNow(POST_SOURCE_COMPLETION_MS + 101);
  monitor.checkNow();
  assert.equal(connection.reconnects, 1, 'an unconfirmed generation grace must still solicit recovery, independent of source completion');
  assert.equal(connection.lastReason, 'HEALTH_GRACE_EXPIRED');
});

test('source-classification D: noon SOURCE_STALL and full STALL -- existing behavior unchanged (source is still fresh mid-session)', () => {
  const middayMs = NIFTY_SOURCE_COMPLETION_BOUNDARY_MS - (3 * 60 + 30) * 60_000; // ~12:00 IST, well before the boundary
  {
    // A full, dead-open STALL at noon -- unaffected by isSourceFresh either way.
    const { connection, monitor, setNow } = setupSourceFreshness(middayMs);
    connection.emit('connected', { generationId: 1 });
    connection.emit('message', Buffer.alloc(0), { generationId: 1 });
    monitor.noteValidMarketEvent(1); monitor.noteNiftyTick(1);
    assert.equal(monitor.confirmRecoveryReady(1), true);
    setNow(middayMs + 101);
    monitor.checkNow();
    assert.equal(connection.reconnects, 1);
    assert.equal(connection.lastReason, 'STALL');
  }
  {
    // A SOURCE_STALL at noon: isSourceFresh(noon) is true, so even the narrow gate still allows
    // the reconnect -- proving the gate is specifically about post-completion time, not about
    // the SOURCE_STALL classification in general.
    const { connection, monitor, setNow } = setupSourceFreshness(middayMs);
    connection.emit('connected', { generationId: 1 });
    connection.emit('message', Buffer.alloc(0), { generationId: 1 }); monitor.noteValidMarketEvent(1); monitor.noteNiftyTick(1, new Date(0));
    assert.equal(monitor.confirmRecoveryReady(1), true);
    setNow(middayMs + 101);
    connection.emit('message', Buffer.alloc(0), { generationId: 1 }); monitor.noteValidMarketEvent(1); monitor.noteNiftyTick(1, new Date(0)); // source timestamp repeats
    monitor.checkNow();
    assert.equal(connection.reconnects, 1, 'a mid-session SOURCE_STALL must still reconnect -- source is still expected to be fresh at noon');
    assert.equal(connection.lastReason, 'SOURCE_STALL');
  }
});

test('the wider 15:40 operational-session gate (isMarketSession) is unchanged -- check() still runs and can still detect a stall right up to it, independent of isSourceFresh', () => {
  const operationalCloseMs = NIFTY_SOURCE_COMPLETION_BOUNDARY_MS + 10 * 60_000; // 15:40:00
  const connection = new FakeConnection();
  let now = operationalCloseMs - 60_000; // 15:39:00
  let inSession = true;
  const monitor = new MarketDataHealthMonitorService(connection as never, {
    stallMs: 100, generationGraceMs: 100, heartbeatCheckMs: 1_000,
    now: () => now,
    isMarketSession: () => inSession, // still governs the overall check() gate, exactly as before
    isSourceFresh: (value) => value.getTime() < NIFTY_SOURCE_COMPLETION_BOUNDARY_MS,
  });
  connection.emit('connected', { generationId: 1 }); // never confirmed -- HEALTH_GRACE_EXPIRED, not gated by isSourceFresh at all
  now = operationalCloseMs - 60_000 + 101; // 15:39:00.101 -- inside the wider session, past the narrower source-freshness boundary
  monitor.checkNow();
  assert.equal(connection.reconnects, 1, 'HEALTH_GRACE_EXPIRED still solicits a reconnect this late, because isMarketSession (15:40) still says the session is active');
  // Once isMarketSession itself says the session has ended, check() short-circuits entirely, unchanged from prior behavior.
  inSession = false;
  const reconnectsBefore = connection.reconnects;
  monitor.checkNow();
  assert.equal(connection.reconnects, reconnectsBefore, 'check() is a no-op once isMarketSession is false, unchanged from prior behavior');
});

// ---- Terra second correction: onStall now conveys {reason, reconnectSolicited}; a permanently
// absent (never null->fresh) NIFTY tick post-completion must not manufacture a false STALL/
// HEALTH_GRACE_EXPIRED loop; confirmPostSourceTransportReady() proves transport readiness
// without ever requiring a NIFTY tick. ----------------------------------------------------

test('onStall now conveys reason and reconnectSolicited explicitly -- a runner never has to re-derive them from snapshot fields', () => {
  const calls: Array<{ reason: string; reconnectSolicited: boolean }> = [];
  const { connection, monitor, setNow } = setupSourceFreshness(POST_SOURCE_COMPLETION_MS - 1_000, (_s, c) => calls.push(c));
  connection.emit('connected', { generationId: 1 });
  connection.emit('message', Buffer.alloc(0), { generationId: 1 }); monitor.noteValidMarketEvent(1); monitor.noteNiftyTick(1, new Date(0));
  assert.equal(monitor.confirmRecoveryReady(1), true);
  setNow(POST_SOURCE_COMPLETION_MS - 1_000 + 101);
  connection.emit('message', Buffer.alloc(0), { generationId: 1 }); monitor.noteValidMarketEvent(1); monitor.noteNiftyTick(1, new Date(0));
  monitor.checkNow();
  assert.deepEqual(calls, [{ reason: 'SOURCE_STALL', reconnectSolicited: false }]);
});

test('confirmPostSourceTransportReady: current-generation raw+valid evidence confirms readiness without any NIFTY tick ever having been accepted this generation', () => {
  const { connection, monitor } = setupSourceFreshness(POST_SOURCE_COMPLETION_MS);
  connection.emit('connected', { generationId: 1 });
  // No noteNiftyTick() call at all for this generation -- only an option/raw valid market event.
  connection.emit('message', Buffer.alloc(0), { generationId: 1 }); monitor.noteValidMarketEvent(1);
  assert.equal(monitor.confirmPostSourceTransportReady(1), true);
  assert.equal(monitor.isHealthy(), true);
  // Observability cleanup: the benign post-source bypass path never emits
  // MARKET_DATA_RECOVERY_CONFIRMED (no source-candle recovery ever happened here) -- it clears
  // reconnect/breaker bookkeeping via the distinct confirmTransportReady() call instead.
  assert.equal(connection.transportConfirmations, 1);
  assert.equal(connection.confirmations, 0, 'must not emit the genuine-source-recovery confirmation for a transport-only bypass');
});

test('confirmRecoveryReady still confirms via the genuine source-recovery path (confirmations), never confirmTransportReady', () => {
  const { connection, monitor } = setupSourceFreshness(POST_SOURCE_COMPLETION_MS - 1_000);
  connection.emit('connected', { generationId: 1 });
  connection.emit('message', Buffer.alloc(0), { generationId: 1 }); monitor.noteValidMarketEvent(1); monitor.noteNiftyTick(1);
  assert.equal(monitor.confirmRecoveryReady(1), true);
  assert.equal(connection.confirmations, 1, 'a genuine source recovery must still emit MARKET_DATA_RECOVERY_CONFIRMED exactly as before');
  assert.equal(connection.transportConfirmations, 0);
});

test('confirmPostSourceTransportReady: a raw message alone (no valid market event) cannot falsely complete readiness', () => {
  const { connection, monitor } = setupSourceFreshness(POST_SOURCE_COMPLETION_MS);
  connection.emit('connected', { generationId: 1 });
  connection.emit('message', Buffer.alloc(0), { generationId: 1 }); // noteValidMarketEvent() never called
  assert.equal(monitor.confirmPostSourceTransportReady(1), false);
});

test('confirmPostSourceTransportReady: wrong generation or disconnected transport is rejected', () => {
  const { connection, monitor } = setupSourceFreshness(POST_SOURCE_COMPLETION_MS);
  connection.emit('connected', { generationId: 1 });
  connection.emit('message', Buffer.alloc(0), { generationId: 1 }); monitor.noteValidMarketEvent(1);
  assert.equal(monitor.confirmPostSourceTransportReady(2), false, 'stale/wrong generation must be rejected');
  connection.state = ConnectionState.RECONNECTING;
  assert.equal(monitor.confirmPostSourceTransportReady(1), false, 'not CONNECTED must be rejected');
});

test('post-completion: a generation that NEVER receives a single NIFTY tick, but keeps healthy raw/valid option traffic, does not loop STALL/reconnect forever once confirmed', () => {
  const { connection, monitor, setNow } = setupSourceFreshness(POST_SOURCE_COMPLETION_MS);
  connection.emit('connected', { generationId: 1 });
  // Grace clears via option traffic alone, exactly as production wiring does from its tick
  // handler (health.confirmPostSourceTransportReady() called inline once state indicates a
  // post-source-completion transport-readiness wait).
  connection.emit('message', Buffer.alloc(0), { generationId: 1 }); monitor.noteValidMarketEvent(1);
  assert.equal(monitor.confirmPostSourceTransportReady(1), true);
  // Several further heartbeat cycles all see continuing option traffic but STILL no NIFTY tick
  // at all this generation -- must never re-trigger STALL/reconnect purely from that absence.
  for (let i = 1; i <= 5; i += 1) {
    setNow(POST_SOURCE_COMPLETION_MS + i * 80);
    connection.emit('message', Buffer.alloc(0), { generationId: 1 }); monitor.noteValidMarketEvent(1);
    monitor.checkNow();
  }
  assert.equal(connection.reconnects, 0, 'a permanently-absent NIFTY tick must never by itself manufacture a reconnect loop once source responsibility is complete');
  assert.equal(monitor.isHealthy(), true);
});

test('post-completion: if raw/valid option traffic itself goes stale, a genuine STALL is still detected and reconnected even with no NIFTY tick this generation', () => {
  const { connection, monitor, setNow } = setupSourceFreshness(POST_SOURCE_COMPLETION_MS);
  connection.emit('connected', { generationId: 1 });
  connection.emit('message', Buffer.alloc(0), { generationId: 1 }); monitor.noteValidMarketEvent(1);
  assert.equal(monitor.confirmPostSourceTransportReady(1), true);
  setNow(POST_SOURCE_COMPLETION_MS + 101); // no further messages/events at all
  monitor.checkNow();
  assert.equal(connection.reconnects, 1);
  assert.equal(connection.lastReason, 'STALL');
});

// ---- Terra third correction: a same-generation SOURCE_STALL must never latch out a LATER
// real transport STALL/HEALTH_GRACE_EXPIRED. reconnectSolicitedGeneration (the ONLY latch that
// gates check()'s early-return / reconnect eligibility) is armed ONLY when a reconnect is
// actually solicited; sourceStallObservedGeneration is a separate, informational-only latch
// that merely dedupes repeated benign SOURCE_STALL reporting and never blocks reconnect
// eligibility. This exact sequence reproduces the production-class Aug-2026 post-15:30 fault:
// raw websocket traffic and valid option/market-event traffic genuinely go dead in the SAME
// generation as an earlier, benign, post-source SOURCE_STALL. ------------------------------

test('same-generation regression: a benign SOURCE_STALL must not block a later real STALL from reconnecting in the SAME generation, and must never storm/duplicate the reconnect', () => {
  const calls: Array<{ reason: string; reconnectSolicited: boolean }> = [];
  const base = POST_SOURCE_COMPLETION_MS - 1_000;
  const { connection, monitor, setNow } = setupSourceFreshness(base, (_s, c) => calls.push(c));
  connection.emit('connected', { generationId: 1 });
  connection.emit('message', Buffer.alloc(0), { generationId: 1 }); monitor.noteValidMarketEvent(1); monitor.noteNiftyTick(1, new Date(0));
  assert.equal(monitor.confirmRecoveryReady(1), true);

  // Phase 1: after the source horizon, raw+valid transport traffic stays fresh -- only the
  // accepted NIFTY source timestamp is stale. A benign, observability-only SOURCE_STALL.
  setNow(base + 101);
  connection.emit('message', Buffer.alloc(0), { generationId: 1 }); monitor.noteValidMarketEvent(1); monitor.noteNiftyTick(1, new Date(0));
  monitor.checkNow();
  assert.equal(connection.reconnects, 0);
  assert.deepEqual(calls, [{ reason: 'SOURCE_STALL', reconnectSolicited: false }]);

  // Phase 2, SAME generation: no generation rotation. The transport itself now goes dead --
  // no new raw message, no new valid market event at all. This MUST be detected as a genuine
  // STALL and reconnected -- never suppressed by the earlier benign SOURCE_STALL.
  setNow(base + 202);
  monitor.checkNow();
  assert.equal(connection.reconnects, 1, 'a later real transport STALL in the same generation must still reconnect');
  assert.equal(connection.lastReason, 'STALL');
  assert.deepEqual(calls[1], { reason: 'STALL', reconnectSolicited: true });

  // Phase 3: calling check() again without a generation rotation must never duplicate/storm the
  // reconnect. Force the transport back to CONNECTED (same generation) to prove this is the
  // reconnectSolicitedGeneration latch itself doing the work, not merely the RECONNECTING state.
  connection.state = ConnectionState.CONNECTED;
  monitor.checkNow();
  assert.equal(connection.reconnects, 1, 'no reconnect storm / duplicate solicitation for the same generation');
  assert.equal(calls.length, 2, 'no further onStall firing for the same already-solicited generation');

  // Rotate to a new generation: the latch must reset normally, proving this is a
  // generation-scoped latch and not a permanently-tripped breaker.
  connection.generation = 2;
  connection.emit('connected', { generationId: 2 });
  setNow(base + 303);
  monitor.checkNow();
  assert.equal(connection.reconnects, 2, 'a fresh generation must be fully eligible for its own grace-expiry reconnect');
  assert.equal(connection.lastReason, 'HEALTH_GRACE_EXPIRED');
});

test('repeated benign SOURCE_STALL alone (same generation, transport otherwise healthy) never accumulates a reconnect, and is reported only once', () => {
  const calls: Array<{ reason: string; reconnectSolicited: boolean }> = [];
  const base = POST_SOURCE_COMPLETION_MS - 1_000;
  const { connection, monitor, setNow } = setupSourceFreshness(base, (_s, c) => calls.push(c));
  connection.emit('connected', { generationId: 1 });
  connection.emit('message', Buffer.alloc(0), { generationId: 1 }); monitor.noteValidMarketEvent(1); monitor.noteNiftyTick(1, new Date(0));
  assert.equal(monitor.confirmRecoveryReady(1), true);
  for (let i = 1; i <= 5; i += 1) {
    setNow(base + i * 80);
    connection.emit('message', Buffer.alloc(0), { generationId: 1 }); monitor.noteValidMarketEvent(1); monitor.noteNiftyTick(1, new Date(0));
    monitor.checkNow();
  }
  assert.equal(connection.reconnects, 0, 'a purely benign, repeatedly-observed SOURCE_STALL must never accumulate a reconnect');
  assert.equal(calls.length, 1, 'repeated identical benign SOURCE_STALL reporting is suppressed after the first observation, per generation');
});

test('invalid health timing configuration fails closed',()=>{
  const connection=new FakeConnection();assert.throws(()=>new MarketDataHealthMonitorService(connection as never,{generationGraceMs:Number.NaN}),/positive finite/);assert.throws(()=>new MarketDataHealthMonitorService(connection as never,{stallMs:0}),/positive finite/);
});

// B1-10: a future NIFTY source timestamp must never poison the health-monitor source
// watermark. Wired exactly like the live scripts (TickProcessor's 'market.tick' ->
// health.noteNiftyTick), the canonical boundary in TickProcessor rejects the poisoned
// packet before it is ever published, so noteNiftyTick never observes it and later
// legitimate source timestamps keep advancing the watermark normally.
test('B1-10: a rejected future NIFTY source timestamp cannot poison the health-monitor watermark or block later legitimate source progression', () => {
  const connection = new FakeConnection();
  const base = Date.UTC(2026, 7, 20, 3, 45, 0); // a real epoch instant -- TickProcessor's numeric-epoch branch requires plausible real-world magnitude
  let now = base;
  const monitor = new MarketDataHealthMonitorService(connection as never, { stallMs: 100, generationGraceMs: 100, heartbeatCheckMs: 1_000, now: () => now, isMarketSession: () => true });
  const bus = new EventEmitter();
  const processor = new TickProcessor(bus, () => now);
  const niftyTicks: MarketTickEvent[] = [];
  bus.on('market.tick', (event: MarketTickEvent) => {
    niftyTicks.push(event);
    monitor.noteValidMarketEvent(event.generationId as number);
    if (event.instrumentKey === 'NSE_INDEX|Nifty 50') monitor.noteNiftyTick(event.generationId as number, new Date(event.timestamp as string));
  });
  const niftyFeed = (currentTs: string) => ({ type: 'live_feed' as const, currentTs, feeds: { 'NSE_INDEX|Nifty 50': { ltpc: { ltp: 24_300 } } } });

  connection.emit('connected', { generationId: 1 });
  // A poisoned future packet arrives first -- must be rejected outright, never published.
  connection.emit('message', Buffer.alloc(0), { generationId: 1 });
  processor.process(niftyFeed(String(now + 60_000)), 1);
  assert.equal(niftyTicks.length, 0);
  assert.equal(monitor.getSnapshot().lastNiftySourceAdvanceAgeMs, null);

  // Legitimate, genuinely advancing source timestamps then progress normally.
  connection.emit('message', Buffer.alloc(0), { generationId: 1 });
  processor.process(niftyFeed(String(now)), 1);
  assert.equal(niftyTicks.length, 1);
  assert.equal(monitor.confirmRecoveryReady(1), true);

  now = base + 50; connection.emit('message', Buffer.alloc(0), { generationId: 1 }); processor.process(niftyFeed(String(now)), 1); monitor.checkNow();
  assert.equal(connection.reconnects, 0);
  now = base + 130; connection.emit('message', Buffer.alloc(0), { generationId: 1 }); processor.process(niftyFeed(String(now)), 1); monitor.checkNow();
  assert.equal(connection.reconnects, 0, 'the poisoned first packet must never have frozen the source watermark ahead of these later legitimate advances');
  assert.equal(monitor.isHealthy(), true);
});
