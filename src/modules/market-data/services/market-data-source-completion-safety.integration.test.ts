import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import ConnectionManager, { ConnectionManagerScheduler, ConnectionState } from '../managers/connection.manager';
import MarketDataHealthMonitorService from './market-data-health-monitor.service';
import MarketDataRecoveryCoordinatorService from './market-data-recovery-coordinator.service';
import { StrategyHostLifecycle } from './strategy-host-lifecycle.service';
import { SourceBoundaryEvaluationCoverageTracker } from './source-boundary-evaluation-coverage';
import { nifty1mSourceCompletionBoundary } from '../../historical-candles/utils/historical-session-completeness.util';
import { resolveSessionOutcome } from '../../research-validation/services/forward-validation.service';

/**
 * Production-topology coverage for the Aug-25 V2/V4 post-source-completion fault (Terra
 * correction): ConnectionManager + MarketDataHealthMonitorService +
 * MarketDataRecoveryCoordinatorService + StrategyHostLifecycle wired together exactly like the
 * live V2/V4/V8 runners' CURRENT wiring -- the bypass decision (source-candle recovery required
 * or not) is made ONCE, at DISCONNECT time, from the runner's own authoritative
 * SourceBoundaryEvaluationCoverageTracker, and routed through
 * handleUnexpectedDisconnectSourceRecoveryNotRequired()/handleReconnectedSourceRecoveryNotRequired()
 * instead of the ordinary handleUnexpectedDisconnect()/handleReconnected() pair when (and only
 * when) that coverage already shows EVALUATED. A coordinator that genuinely attempts recovery
 * and genuinely fails still escalates exactly as before (stateChanged FAULTED ->
 * connectionManager.failRecovery(...)).
 *
 * V2 and V4 arm/mark their tracker from a wall-clock-triggered final evaluation (see the real
 * runners' performSourceBoundaryEvaluation()); V8 arms/marks the SAME tracker class from its
 * normal live 2m-candle evaluator path, using a fixed session-scoped token instead of the
 * connection generationId (see test-live-v8-nifty-bullish-reclaim-shadow.ts). Both mechanics are
 * exercised by their own dedicated tests elsewhere; here the tracker's EVALUATED/LOST/PENDING
 * disposition is driven directly, since it is the exact input this wiring layer's decision
 * reads -- this file's job is to prove the WIRING's reaction, not re-derive how the disposition
 * itself gets set.
 *
 * The coordinator itself (its no-safe-handoff fail-closed rule, A7-H4/H5/H6, and the new
 * handleUnexpectedDisconnectSourceRecoveryNotRequired()/handleReconnectedSourceRecoveryNotRequired()
 * pair) is exercised directly, in isolation, by market-data-recovery-coordinator.service.test.ts
 * -- not re-tested here.
 */

class Clock implements ConnectionManagerScheduler {
  now = 0; private id = 0; private readonly timers = new Map<number, { at: number; callback: () => void }>();
  setTimeout(callback: () => void, delayMs: number): number { const id = ++this.id; this.timers.set(id, { at: this.now + delayMs, callback }); return id; }
  clearTimeout(handle: unknown): void { this.timers.delete(handle as number); }
  advanceBy(milliseconds: number): void { const target = this.now + milliseconds; let next = [...this.timers].sort((a, b) => a[1].at - b[1].at).find(([, timer]) => timer.at <= target); while (next) { this.timers.delete(next[0]); this.now = next[1].at; next[1].callback(); next = [...this.timers].sort((a, b) => a[1].at - b[1].at).find(([, timer]) => timer.at <= target); } this.now = target; }
}
class Client extends EventEmitter { connects = 0; async connect(): Promise<void> { this.connects += 1; this.emit('connected'); } disconnect(): void {} disconnectForRecovery(): void { this.emit('disconnected', { code: 1006 }, true); } send(): void {} }
const flush = async (): Promise<void> => { for (let i = 0; i < 16; i += 1) await Promise.resolve(); };

// A fixed 2026-08-24 (Monday) trading day, expressed as real IST wall-clock instants so the
// canonical nifty1mSourceCompletionBoundary utility is reused exactly as production does --
// never a duplicate hardcoded 15:30 constant.
const ist = (h: number, m: number, s = 0): number => Date.UTC(2026, 7, 24, h - 5, m - 30, s);

interface RecoveryData { latest: Date }
interface JournalEntry { event: string; details: Record<string, unknown> }

/**
 * @param wireHealthOnStall When true, wires health.onStall exactly like the real V2/V4/V8
 * runners (see test-live-v8-nifty-bullish-reclaim-shadow.ts): a reconnectSolicited=true event
 * calls handleUnexpectedDisconnect (bypass-gated) directly, BEFORE ConnectionManager's own
 * 'unexpectedDisconnect' event fires for the same episode; reconnectSolicited=false never calls
 * it at all. Defaults to false (health.onStall left unwired) for every existing caller, whose
 * disconnects are all driven directly through the real client 'disconnected' event instead --
 * this flag exists specifically to exercise the health-monitor-driven reconnect path's own
 * runner-equivalent listener ordering (Terra third correction).
 */
function buildStack(alignmentMinutes: number, options: { wireHealthOnStall?: boolean } = {}) {
  const clock = new Clock();
  const client = new Client();
  // maximumReconnectDurationMs is generously large (well beyond any single synthetic clock
  // jump this file makes) -- it bounds ConnectionManager's own reconnect-attempt budget, an
  // unrelated concern from the source-completion boundary under test here.
  const connection = new ConnectionManager('token', client as never, { maximumReconnectAttempts: 3, maximumReconnectDurationMs: 30 * 60_000, reconnectJitterMs: 0, initialReconnectDelayMs: 10, maximumReconnectDelayMs: 40, now: () => clock.now, scheduler: clock });
  const coverage = new SourceBoundaryEvaluationCoverageTracker('test', 'TEST');
  const journal: JournalEntry[] = [];
  const host = new StrategyHostLifecycle({ strategyId: 'TEST', runtimeId: 'test', hooks: { warmup: () => undefined, onEod: () => undefined, onShutdown: () => undefined, onFault: () => undefined } });
  // Decided ONCE, at the START of each disconnect/reconnect episode, from the runner's OWN
  // generation-independent authoritative truth -- never decided after the fact from a FAULTED
  // coordinator (see BLOCKER 3 of the Terra correction). Mirrors the real V2/V4/V8 wiring.
  // Declared before `recovery`/`health` (both referenced only from callbacks invoked later, once
  // the whole stack is fully constructed) so it can be shared by health.onStall and
  // connection.on('unexpectedDisconnect', ...) below.
  let sourceRecoveryBypassActive = false;
  const recovery = new MarketDataRecoveryCoordinatorService<RecoveryData>({
    nowMs: () => clock.now,
    getLastSeededCompletedMinute: () => null,
    liveConstructionAlignmentMinutes: alignmentMinutes,
    getSourceCompletionBoundary: nifty1mSourceCompletionBoundary,
    getRecoveredCompletedMinute: (data) => data?.latest,
    backfill: async (target) => ({ ready: true, reason: 'OK', missingMinutes: 0, duplicateMinutes: 0, recoveryData: { latest: target ?? new Date(clock.now) } }),
    onEvent: (eventType, details) => { journal.push({ event: eventType, details }); },
  });
  const health = new MarketDataHealthMonitorService(connection, {
    stallMs: 100, generationGraceMs: 100, now: () => clock.now, isMarketSession: () => true, isSourceFresh: (value) => value.getTime() < nifty1mSourceCompletionBoundary(value).getTime(),
    onStall: options.wireHealthOnStall ? (snapshot, { reconnectSolicited }) => {
      if (!reconnectSolicited) return; // benign SOURCE_STALL: observability only, never starts a coordinator episode
      sourceRecoveryBypassActive = coverage.getRecord()?.disposition === 'EVALUATED';
      if (sourceRecoveryBypassActive) recovery.handleUnexpectedDisconnectSourceRecoveryNotRequired({ generationId: snapshot.generationId });
      else recovery.handleUnexpectedDisconnect({ generationId: snapshot.generationId });
    } : undefined,
  });
  connection.on('unexpectedDisconnect', (details) => {
    sourceRecoveryBypassActive = coverage.getRecord()?.disposition === 'EVALUATED';
    if (sourceRecoveryBypassActive) recovery.handleUnexpectedDisconnectSourceRecoveryNotRequired(details);
    else recovery.handleUnexpectedDisconnect(details);
  });
  connection.on('reconnected', (details) => {
    if (sourceRecoveryBypassActive) recovery.handleReconnectedSourceRecoveryNotRequired(details);
    else recovery.handleReconnected(details);
  });
  connection.on('reconnectFailed', (details: { reason?: string }) => { recovery.fault(details.reason); void host.fault(new Error(details.reason ?? 'RECONNECT_FAILED')); });
  recovery.on('stateChanged', (state) => {
    if (state === 'DEGRADED') void host.degrade('MARKET_DATA_DEGRADED');
    if (state === 'READY' && health.confirmRecoveryReady(recovery.getGenerationId())) void host.recovered('MARKET_DATA_READY');
    // SOURCE_COMPLETE_READY mirrors the READY branch above exactly, but confirms via
    // confirmPostSourceTransportReady() (transport evidence: raw+valid, never a NIFTY tick)
    // instead of confirmRecoveryReady() (which would require one that is not guaranteed to
    // ever arrive again post-completion).
    if (state === 'SOURCE_COMPLETE_READY' && health.confirmPostSourceTransportReady(recovery.getGenerationId())) void host.recovered('MARKET_DATA_READY');
    // A FAULTED coordinator here always means a source-candle recovery was genuinely attempted
    // and genuinely failed -- a benign post-source-completion transport episode never reaches
    // handleReconnected()/FAULTED at all; see the bypass-gated handlers above. Exactly the
    // real V2/V4/V8 wiring's own unconditional escalation.
    if (state === 'FAULTED') connection.failRecovery(recovery.getGenerationId(), 'RECOVERY_COORDINATOR_FAULTED');
  });
  const emitNiftyTick = (generationId: number): void => { connection.emit('message', Buffer.alloc(0), { generationId }); health.noteValidMarketEvent(generationId); health.noteNiftyTick(generationId); recovery.handleLiveTick({ sourceTimestamp: new Date(clock.now), receivedAt: new Date(clock.now), generationId }); };
  // Mirrors the real runners' tick handler: an OPTION tick (or any non-NIFTY valid market
  // event) always notes health evidence, and -- when the coordinator is specifically waiting
  // for post-source transport confirmation -- drives that confirmation through, exactly like
  // the production `handleMarketTick`/`handleTick` wiring.
  const emitOptionTick = (generationId: number): void => {
    connection.emit('message', Buffer.alloc(0), { generationId });
    health.noteValidMarketEvent(generationId);
    if (recovery.getState() === 'SOURCE_COMPLETE_WAITING_FOR_TRANSPORT' && health.confirmPostSourceTransportReady(generationId)) {
      recovery.handleTransportReadySourceRecoveryNotRequired(generationId);
    }
  };
  /** Simulates the final source-boundary/final-opportunity evaluation genuinely completing under the CURRENT generation. */
  const markFinalOpportunityEvaluated = (): void => {
    const generationId = connection.getGenerationId();
    coverage.require(generationId, nifty1mSourceCompletionBoundary(new Date(clock.now)));
    coverage.markEvaluated(generationId, new Date(clock.now), 'FINAL_OPPORTUNITY_EVALUATED');
  };
  /** Mirrors the runner's own EOD-time guard: sourceBoundaryEvaluationCoverage EVALUATED is authoritative and skips completePendingBoundaryReconciliation()'s generation-scoped barrier entirely. */
  const evaluateEodOutcome = async (reason: string): Promise<{ status: string; sessionCompleted: boolean }> => {
    const alreadyEvaluatedThisSession = coverage.getRecord()?.disposition === 'EVALUATED';
    const boundaryReconciliation = alreadyEvaluatedThisSession
      ? { outcome: 'RECOVERED' as const }
      : await recovery.completePendingBoundaryReconciliation();
    const invalidData = boundaryReconciliation.outcome === 'NOT_RECOVERED';
    return resolveSessionOutcome({ reason, invalidData });
  };
  return { clock, client, connection, health, recovery, host, coverage, journal, emitNiftyTick, emitOptionTick, markFinalOpportunityEvaluated, evaluateEodOutcome };
}

/** Drives one disconnect -> reconnect cycle through the real ConnectionManager/transport path (mirrors a genuine websocket drop, not a health-monitor-driven one) and returns once it has settled. */
async function disconnectAndReconnect(stack: { client: Client; clock: Clock }): Promise<void> {
  stack.client.emit('disconnected', { code: 1006 }, true);
  await flush();
  stack.clock.advanceBy(10);
  await flush();
}

/** Completes one ordinary (safe, pre-source-horizon) reconnect-to-READY cycle, exactly like production. */
async function completeOrdinaryRecovery(stack: { client: Client; clock: Clock; connection: ConnectionManager; emitNiftyTick: (generationId: number) => void }, alignmentMinutes: number): Promise<void> {
  await disconnectAndReconnect(stack);
  stack.clock.advanceBy((alignmentMinutes + 1) * 60_000);
  stack.emitNiftyTick(stack.connection.getGenerationId());
  await flush();
  stack.emitNiftyTick(stack.connection.getGenerationId());
  await flush();
}

// ---- 1/2/3. Benign post-source-completion transport episode: no fault, no breaker OPEN, EOD reaches VALID_COMPLETED ----

for (const [label, alignmentMinutes] of [['V2-style (5m)', 5], ['V4-style (15m)', 15], ['V8-style (2m)', 2]] as const) {
  test(`${label}: final opportunity EVALUATED -> a later full transport STALL/reconnect is a source-recovery-not-required bypass -- no fault, breaker stays closed, host not FAULTED, EOD reaches VALID_COMPLETED`, async () => {
    const stack = buildStack(alignmentMinutes);
    const { clock, connection, recovery, host, journal } = stack;
    clock.now = ist(9, 20, 0);
    await host.start();
    await connection.connect();
    await completeOrdinaryRecovery(stack, alignmentMinutes);
    assert.equal(host.getState(), 'RUNNING');

    // The one required final opportunity for this session genuinely completes.
    clock.now = ist(15, 29, 0);
    stack.markFinalOpportunityEvaluated();
    const evaluatedGenerationId = connection.getGenerationId();

    // A later, genuine full transport STALL well after the source horizon reconnects
    // successfully at the transport level.
    clock.now = ist(15, 33, 0);
    await disconnectAndReconnect(stack);

    assert.notEqual(connection.getGenerationId(), evaluatedGenerationId, 'a real reconnect occurred, advancing the generation');
    assert.equal(recovery.getState(), 'SOURCE_COMPLETE_WAITING_FOR_TRANSPORT', 'never FAULTED for a bypassed episode, and never the NIFTY-tick-only WAITING_FOR_FRESH_TICK');
    assert.equal(journal.some((e) => e.event === 'MARKET_DATA_SOURCE_RECOVERY_NOT_REQUIRED'), true, 'truthfully distinguishable from both MARKET_DATA_RECOVERY_CONFIRMED and an escalated MARKET_DATA_RECOVERY_FAILED');
    assert.equal(journal.some((e) => e.event === 'DATA_GAP_UNRECOVERABLE' || e.event === 'MARKET_DATA_RECOVERY_FAILED'), false, 'must never be preceded by a coordinator fault for the same bypassed episode');
    assert.equal(connection.getState(), ConnectionState.CONNECTED, 'breaker must never open for a benign post-source-completion episode');
    assert.equal(connection.getReconnectCircuitSnapshot().state, 'CLOSED');
    assert.notEqual(host.getState(), 'FAULTED');

    // A genuine option/non-NIFTY tick on the new connection -- never a NIFTY tick -- confirms
    // transport readiness and settles the coordinator into SOURCE_COMPLETE_READY.
    stack.emitOptionTick(connection.getGenerationId());
    await flush();
    assert.equal(recovery.getState(), 'SOURCE_COMPLETE_READY');
    assert.equal(recovery.isEvaluationReady(), true);
    assert.equal(host.getState(), 'RUNNING');

    // EOD: the durable outcome is not invalidated solely by this benign episode.
    const outcome = await stack.evaluateEodOutcome('EOD');
    assert.equal(outcome.status, 'VALID_COMPLETED');
    assert.equal(outcome.sessionCompleted, true);
  });
}

// ---- Terra third correction: runner-equivalent listener ordering for a HEALTH-DRIVEN
// (not raw-socket-driven) reconnect -- a benign post-source SOURCE_STALL must never start a
// coordinator episode, but a LATER real transport STALL in the SAME generation must, and must be
// routed through the correct source-recovery-not-required bypass exactly like the real V2/V4/V8
// runners' health.onStall wiring (see test-live-v8-nifty-bullish-reclaim-shadow.ts). The tests
// above all drive their disconnect/reconnect via the raw client 'disconnected' event, which never
// exercises health.onStall or MarketDataHealthMonitorService's own SOURCE_STALL/STALL
// classification -- that classification is unit-tested in isolation by
// market-data-health-monitor.service.test.ts; this test's job is only to prove the WIRING's
// reaction once health.onStall is the one soliciting the reconnect. ----------------------------

test('runner-equivalent wiring: a benign post-source SOURCE_STALL never starts a coordinator episode, but a LATER real transport STALL in the SAME generation reconnects and takes the source-recovery-not-required bypass', async () => {
  const stack = buildStack(5, { wireHealthOnStall: true });
  const { clock, connection, recovery, health, host, journal } = stack;
  clock.now = ist(9, 20, 0);
  await host.start();
  await connection.connect();
  await completeOrdinaryRecovery(stack, 5);
  assert.equal(host.getState(), 'RUNNING');
  // Seed the source-time watermark once with a real sourceTimestamp (the shared emitNiftyTick
  // helper deliberately omits it -- see its own doc -- so this integration file's existing tests
  // never engage source-time tracking at all) so the benign SOURCE_STALL phase below has a
  // genuine prior advance to go stale relative to.
  health.noteNiftyTick(connection.getGenerationId(), new Date(clock.now));

  clock.now = ist(15, 29, 0);
  stack.markFinalOpportunityEvaluated();
  const evaluatedGenerationId = connection.getGenerationId();
  // Startup's own cold-start disconnect/reconnect cycle (completeOrdinaryRecovery) legitimately
  // logs its own MARKET_DATA_DEGRADED earlier -- only journal entries appended from here on are
  // relevant to the benign-SOURCE_STALL assertion below.
  const journalLengthBeforePhase1 = journal.length;

  // Phase 1: post-15:30, raw+valid transport traffic stays fresh; only the accepted NIFTY
  // source timestamp is stale (never re-noted since the seed above) -- a benign, health-driven
  // SOURCE_STALL. Must NOT start any coordinator episode or reconnect at all.
  clock.now = ist(15, 33, 0);
  connection.emit('message', Buffer.alloc(0), { generationId: evaluatedGenerationId });
  health.noteValidMarketEvent(evaluatedGenerationId);
  health.checkNow();
  assert.equal(connection.getGenerationId(), evaluatedGenerationId, 'a benign SOURCE_STALL must never reconnect');
  assert.equal(connection.getState(), ConnectionState.CONNECTED);
  assert.equal(host.getState(), 'RUNNING');
  assert.equal(journal.slice(journalLengthBeforePhase1).some((e) => e.event === 'MARKET_DATA_DEGRADED'), false, 'a benign SOURCE_STALL must never start a coordinator episode');

  // Phase 2, SAME generation: no further raw/valid traffic at all -- the transport itself now
  // goes dead. Unlike before this correction, this MUST still be detected as a genuine STALL and
  // MUST reconnect, never suppressed by the earlier benign SOURCE_STALL in this same generation.
  clock.now = ist(15, 34, 45);
  health.checkNow();
  await flush();
  clock.advanceBy(10);
  await flush();

  assert.notEqual(connection.getGenerationId(), evaluatedGenerationId, 'the later real STALL in the same generation must actually have reconnected the transport');
  assert.equal(recovery.getState(), 'SOURCE_COMPLETE_WAITING_FOR_TRANSPORT', 'the already-EVALUATED final opportunity routes this through the source-recovery-not-required bypass -- never FAULTED, never the NIFTY-tick-only WAITING_FOR_FRESH_TICK');
  assert.equal(journal.some((e) => e.event === 'MARKET_DATA_SOURCE_RECOVERY_NOT_REQUIRED'), true);
  assert.equal(journal.some((e) => e.event === 'DATA_GAP_UNRECOVERABLE' || e.event === 'MARKET_DATA_RECOVERY_FAILED'), false, 'must never be preceded by a coordinator fault for the same bypassed episode');
  assert.equal(connection.getState(), ConnectionState.CONNECTED, 'breaker must never open for a benign post-source-completion episode');
  assert.notEqual(host.getState(), 'FAULTED');

  // A genuine option/non-NIFTY tick on the new connection confirms transport readiness.
  stack.emitOptionTick(connection.getGenerationId());
  await flush();
  assert.equal(recovery.getState(), 'SOURCE_COMPLETE_READY');
  assert.equal(host.getState(), 'RUNNING');
});

// ---- 5/6. Post-source transport recovery with no NIFTY tick, and with no transport evidence ----

test('post-source transport recovery with no NIFTY tick: current-generation option evidence alone reaches SOURCE_COMPLETE_READY; the coordinator never remains stuck waiting for a tick that will never come', async () => {
  const stack = buildStack(5);
  const { clock, connection, recovery, host, journal } = stack;
  clock.now = ist(9, 20, 0);
  await host.start();
  await connection.connect();
  await completeOrdinaryRecovery(stack, 5);

  clock.now = ist(15, 29, 0);
  stack.markFinalOpportunityEvaluated();

  clock.now = ist(15, 33, 0);
  await disconnectAndReconnect(stack);
  assert.equal(recovery.getState(), 'SOURCE_COMPLETE_WAITING_FOR_TRANSPORT');

  // Only raw + a valid option market event arrive on the new generation -- no NIFTY tick ever.
  stack.emitOptionTick(connection.getGenerationId());
  await flush();
  assert.equal(recovery.getState(), 'SOURCE_COMPLETE_READY', 'transport evidence alone must resolve this, never requiring a NIFTY tick');
  assert.equal(recovery.isEvaluationReady(), true);
  assert.equal(host.getState(), 'RUNNING', 'host must not remain DEGRADED once transport is proven alive');
  assert.equal(journal.some((e) => e.event === 'DATA_GAP_UNRECOVERABLE'), false);
  assert.equal(connection.getReconnectCircuitSnapshot().state, 'CLOSED');
});

test('post-source transport recovery with NO evidence at all: health grace expires and another reconnect is solicited -- never a fake source-recovery-not-required success', async () => {
  const stack = buildStack(5);
  const { clock, connection, recovery, host } = stack;
  clock.now = ist(9, 20, 0);
  await host.start();
  await connection.connect();
  await completeOrdinaryRecovery(stack, 5);

  clock.now = ist(15, 29, 0);
  stack.markFinalOpportunityEvaluated();

  clock.now = ist(15, 33, 0);
  await disconnectAndReconnect(stack);
  assert.equal(recovery.getState(), 'SOURCE_COMPLETE_WAITING_FOR_TRANSPORT');

  // No message/tick at all arrives on the new generation -- health grace (100ms) expires.
  // (health.start()'s own setInterval is real-timer-driven and not tied to this suite's virtual
  // Clock, so the heartbeat is driven explicitly here, exactly like the health-monitor unit
  // tests already do via checkNow().)
  stack.clock.advanceBy(150);
  stack.health.checkNow();
  await flush();

  // Grace expiry with zero evidence never fabricates SOURCE_COMPLETE_READY; instead it solicits
  // a genuine new transport reconnect episode (mirrors "STALL/HEALTH_GRACE_EXPIRED must always
  // reconnect" -- the coordinator correctly starts a fresh, unrelated disconnect/reconnect
  // cycle rather than being left stuck).
  assert.notEqual(recovery.getState(), 'SOURCE_COMPLETE_READY', 'must never fabricate SOURCE_COMPLETE_READY without genuine evidence');
  assert.notEqual(host.getState(), 'RUNNING');
  assert.equal(connection.getReconnectCircuitSnapshot().reconnectEpisodeActive, true, 'health-driven grace expiry must still solicit another transport reconnect');
});

// ---- 4/5. Negative: missing/lost/pending final coverage MUST remain fail-closed ----

test('V8-style negative: disconnect before the final opportunity ever reaches the evaluator -> reconnect after the source horizon -> evidence absent (still REQUIRED_PENDING) -> MUST remain fail closed, and EOD cannot become VALID_COMPLETED', async () => {
  const stack = buildStack(2);
  const { clock, connection, recovery, host } = stack;
  clock.now = ist(9, 20, 0);
  await host.start();
  await connection.connect();
  await completeOrdinaryRecovery(stack, 2);
  assert.equal(host.getState(), 'RUNNING');

  // The final-opportunity requirement is armed (mirrors the real runner arming it unconditionally
  // at startup) but NEVER evaluated -- a disconnect intervenes before it can ever be reached.
  stack.coverage.require(connection.getGenerationId(), new Date(ist(15, 27, 0)));

  clock.now = ist(15, 33, 0);
  await disconnectAndReconnect(stack);

  assert.equal(recovery.getState(), 'FAULTED', "the coordinator's own no-safe-handoff fail-closed rule (A7-H4) is unchanged");
  assert.equal(connection.getState(), ConnectionState.FAULTED, 'breaker must open -- missing final-opportunity evidence is still correctness-relevant');
  assert.equal(host.getState(), 'FAULTED');

  const outcome = await stack.evaluateEodOutcome('FAULTED');
  assert.notEqual(outcome.status, 'VALID_COMPLETED');
  assert.equal(outcome.sessionCompleted, false);
});

test('V2/V4-style negative: final source-boundary coverage LOST -> reconnect after the source horizon -> MUST remain fail closed, and EOD cannot become VALID_COMPLETED', async () => {
  const stack = buildStack(5);
  const { clock, connection, recovery, host } = stack;
  clock.now = ist(9, 20, 0);
  await host.start();
  await connection.connect();
  await completeOrdinaryRecovery(stack, 5);
  assert.equal(host.getState(), 'RUNNING');

  // The one required final evaluation attempt genuinely failed (e.g. the exact 15:29:58/15:30:00/
  // 15:30:02 race: a disconnect poisons the attempt right as it fires).
  stack.coverage.require(connection.getGenerationId(), new Date(ist(15, 30, 0)));
  stack.coverage.markLost(connection.getGenerationId(), 'REQUIRED_RECOVERY_INVALIDATED_BY_DISCONNECT');

  clock.now = ist(15, 33, 0);
  await disconnectAndReconnect(stack);

  assert.equal(recovery.getState(), 'FAULTED');
  assert.equal(connection.getState(), ConnectionState.FAULTED, 'must remain fail-closed exactly as before this fix (A7-H5)');
  assert.equal(host.getState(), 'FAULTED');

  const outcome = await stack.evaluateEodOutcome('FAULTED');
  assert.notEqual(outcome.status, 'VALID_COMPLETED');
  assert.equal(outcome.sessionCompleted, false);
});

// ---- 9. Mid-session control: a genuine unrecoverable gap must still fault exactly as before ----

test('mid-session control: a genuine backfill failure around 12:00 IST still opens the breaker and faults the host -- this fix must never suppress a real unrecoverable gap', async () => {
  const clock = new Clock(); const client = new Client();
  const connection = new ConnectionManager('token', client as never, { maximumReconnectAttempts: 3, maximumReconnectDurationMs: 30 * 60_000, reconnectJitterMs: 0, initialReconnectDelayMs: 10, maximumReconnectDelayMs: 40, now: () => clock.now, scheduler: clock });
  const health = new MarketDataHealthMonitorService(connection, { stallMs: 100, generationGraceMs: 100, now: () => clock.now, isMarketSession: () => true, isSourceFresh: (value) => value.getTime() < nifty1mSourceCompletionBoundary(value).getTime() });
  const coverage = new SourceBoundaryEvaluationCoverageTracker('test', 'TEST');
  const host = new StrategyHostLifecycle({ strategyId: 'TEST', runtimeId: 'test', hooks: { warmup: () => undefined, onEod: () => undefined, onShutdown: () => undefined, onFault: () => undefined } });
  const recovery = new MarketDataRecoveryCoordinatorService<RecoveryData>({
    nowMs: () => clock.now,
    backfill: async () => ({ ready: false, reason: 'REST_PROVIDER_UNAVAILABLE', missingMinutes: 5, duplicateMinutes: 0 }),
  });
  let sourceRecoveryBypassActive = false;
  connection.on('unexpectedDisconnect', (details) => {
    sourceRecoveryBypassActive = coverage.getRecord()?.disposition === 'EVALUATED';
    if (sourceRecoveryBypassActive) recovery.handleUnexpectedDisconnectSourceRecoveryNotRequired(details);
    else recovery.handleUnexpectedDisconnect(details);
  });
  connection.on('reconnected', (details) => { if (sourceRecoveryBypassActive) recovery.handleReconnectedSourceRecoveryNotRequired(details); else recovery.handleReconnected(details); });
  connection.on('reconnectFailed', (details: { reason?: string }) => { recovery.fault(details.reason); void host.fault(new Error(details.reason ?? 'RECONNECT_FAILED')); });
  recovery.on('stateChanged', (state) => { if (state === 'DEGRADED') void host.degrade('MARKET_DATA_DEGRADED'); if (state === 'READY' && health.confirmRecoveryReady(recovery.getGenerationId())) void host.recovered('MARKET_DATA_READY'); if (state === 'FAULTED') connection.failRecovery(recovery.getGenerationId(), 'RECOVERY_COORDINATOR_FAULTED'); });

  clock.now = ist(12, 0, 0);
  await host.start(); await connection.connect();
  connection.emit('message', Buffer.alloc(0), { generationId: 1 }); health.noteValidMarketEvent(1); health.noteNiftyTick(1);
  assert.equal(health.confirmRecoveryReady(1), true);

  client.emit('disconnected', { code: 1006 }, true); await flush();
  clock.advanceBy(10); await flush();

  assert.equal(recovery.getState(), 'FAULTED');
  assert.equal(connection.getState(), ConnectionState.FAULTED, 'the breaker must still open for a genuine unrecoverable gap');
  assert.equal(host.getState(), 'FAULTED', 'the host must still fault for a genuine unrecoverable gap');
});

// ---- 10. Before source completion: unaffected ----

test('before-boundary: a reconnect at 15:20 IST, well before the source horizon, reaches READY normally -- completely unchanged', async () => {
  const stack = buildStack(5);
  const { clock, connection, recovery, host, journal } = stack;
  clock.now = ist(9, 20, 0);
  await host.start(); await connection.connect();
  await completeOrdinaryRecovery(stack, 5);
  assert.equal(host.getState(), 'RUNNING');

  clock.now = ist(15, 20, 0);
  await completeOrdinaryRecovery(stack, 5);

  assert.equal(recovery.getState(), 'READY');
  assert.equal(host.getState(), 'RUNNING');
  assert.equal(journal.some((e) => e.event === 'MARKET_DATA_SOURCE_RECOVERY_NOT_REQUIRED'), false, 'the bypass path must never be reached when a safe handoff genuinely exists');
  assert.equal(connection.getState(), ConnectionState.CONNECTED);
});

// ---- 14. No duplicate evaluation marking ----

test('duplicate markEvaluated calls for the same generation are idempotent -- no double-evaluation', () => {
  const coverage = new SourceBoundaryEvaluationCoverageTracker('test', 'TEST');
  const boundary = new Date(ist(15, 30, 0));
  const firstCandle = new Date(ist(15, 29, 0));
  const secondCandle = new Date(ist(15, 29, 30));
  coverage.require(1, boundary);
  assert.equal(coverage.markEvaluated(1, firstCandle, 'FIRST'), true);
  assert.equal(coverage.markEvaluated(1, secondCandle, 'SECOND'), true);
  assert.equal(coverage.getRecord()?.completedCandleTime?.getTime(), firstCandle.getTime(), 'the first EVALUATED mark is sticky -- a later duplicate callback cannot overwrite it');
  assert.equal(coverage.getRecord()?.reason, 'FIRST');
});
