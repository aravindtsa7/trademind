import assert from 'node:assert/strict';
import test from 'node:test';
import { StrategyTerminalOutcomeArbiter } from './strategy-terminal-outcome-arbiter.service';

test('a higher-precedence proposal escalates the pending reason before commit', () => {
  const arbiter = new StrategyTerminalOutcomeArbiter();
  arbiter.propose('EOD_NSE_SESSION_CLOSE', 'VALID_COMPLETED');
  arbiter.propose('RECONNECT_FAILED', 'FAULTED');
  assert.equal(arbiter.isCommitted(), false);
});

test('a lower-precedence proposal never downgrades an already-higher pending reason', async () => {
  const arbiter = new StrategyTerminalOutcomeArbiter();
  arbiter.propose('RECONNECT_FAILED', 'FAULTED');
  arbiter.propose('SIGINT', 'MANUAL_STOP'); // must not win against FAULTED
  const written: string[] = [];
  const reason = await arbiter.commit((r) => { written.push(r); return r; });
  assert.equal(reason, 'RECONNECT_FAILED');
  assert.deepEqual(written, ['RECONNECT_FAILED']);
});

test('RECONCILIATION_REQUIRED outranks FAULTED when both are proposed', async () => {
  const arbiter = new StrategyTerminalOutcomeArbiter();
  arbiter.propose('RECONNECT_FAILED', 'FAULTED');
  arbiter.propose('POSITION_STUCK', 'RECONCILIATION_REQUIRED');
  const reason = await arbiter.commit((r) => r);
  assert.equal(reason, 'POSITION_STUCK');
});

test('commit() runs the writer exactly once even when called repeatedly (H: repeated fault produces one authoritative outcome)', async () => {
  const arbiter = new StrategyTerminalOutcomeArbiter();
  let writes = 0;
  arbiter.propose('RECONNECT_FAILED', 'FAULTED');
  const first = await arbiter.commit(() => { writes += 1; return 'first'; });
  arbiter.propose('SECOND_FAULT', 'FAULTED'); // ignored -- already committed
  const second = await arbiter.commit(() => { writes += 1; return 'second'; });
  assert.equal(writes, 1);
  assert.equal(first, 'first');
  assert.equal(second, undefined); // a post-commit commit() call is a no-op, not a re-write
  assert.equal(arbiter.getCommittedReason(), 'RECONNECT_FAILED');
});

test('propose() after commit() is a no-op and cannot change the already-committed reason', async () => {
  const arbiter = new StrategyTerminalOutcomeArbiter();
  arbiter.propose('EOD_NSE_SESSION_CLOSE', 'VALID_COMPLETED');
  await arbiter.commit((r) => r);
  assert.equal(arbiter.getCommittedReason(), 'EOD_NSE_SESSION_CLOSE');
  arbiter.propose('POST_COMMIT_FAULT', 'FAULTED'); // must not rewrite history
  assert.equal(arbiter.getCommittedReason(), 'EOD_NSE_SESSION_CLOSE');
  assert.equal(arbiter.isCommitted(), true);
});

test('concurrent commit() calls join the same in-flight write and both observe the identical result (no double write)', async () => {
  const arbiter = new StrategyTerminalOutcomeArbiter();
  let writes = 0;
  const gate = new Promise<void>((resolve) => setTimeout(resolve, 5));
  arbiter.propose('EOD_NSE_SESSION_CLOSE', 'VALID_COMPLETED');
  const write = async (reason: string): Promise<string> => { await gate; writes += 1; return reason; };
  const [a, b] = await Promise.all([arbiter.commit(write), arbiter.commit(write)]);
  assert.equal(writes, 1);
  assert.equal(a, 'EOD_NSE_SESSION_CLOSE');
  assert.equal(b, 'EOD_NSE_SESSION_CLOSE');
});

test('N: a throwing writer fails closed -- no committed reason, no fabricated outcome, and the rejection propagates without deadlock or recursion', async () => {
  const arbiter = new StrategyTerminalOutcomeArbiter();
  arbiter.propose('EOD_NSE_SESSION_CLOSE', 'VALID_COMPLETED');
  await assert.rejects(() => arbiter.commit(() => { throw new Error('JOURNAL_WRITE_FAILED'); }), /JOURNAL_WRITE_FAILED/);
  assert.equal(arbiter.isCommitted(), false); // never fabricates a committed VALID_COMPLETED outcome
  assert.equal(arbiter.getCommittedReason(), undefined);
  // A subsequent commit() attempt is not stuck behind the failed one (no deadlock) and can still run.
  const reason = await arbiter.commit((r) => r);
  assert.equal(reason, 'EOD_NSE_SESSION_CLOSE');
  assert.equal(arbiter.isCommitted(), true);
});

test('commit() before any propose() throws rather than silently writing an unproposed reason', async () => {
  const arbiter = new StrategyTerminalOutcomeArbiter();
  await assert.rejects(() => arbiter.commit((r) => r), /before any propose/);
});

test('L: a fault proposed immediately before commit() still wins -- commit() always reads the latest pending reason', async () => {
  const arbiter = new StrategyTerminalOutcomeArbiter();
  arbiter.propose('EOD_NSE_SESSION_CLOSE', 'VALID_COMPLETED');
  arbiter.propose('RECONNECT_FAILED', 'FAULTED'); // arrives immediately before commit()
  const reason = await arbiter.commit((r) => r);
  assert.equal(reason, 'RECONNECT_FAILED');
});

test('M: a fault proposed immediately after the committed terminal boundary cannot rewrite the already-committed outcome', async () => {
  const arbiter = new StrategyTerminalOutcomeArbiter();
  arbiter.propose('EOD_NSE_SESSION_CLOSE', 'VALID_COMPLETED');
  const committedReason = await arbiter.commit((r) => r);
  arbiter.propose('RECONNECT_FAILED', 'FAULTED'); // arrives immediately after commit()
  assert.equal(committedReason, 'EOD_NSE_SESSION_CLOSE');
  assert.equal(arbiter.getCommittedReason(), 'EOD_NSE_SESSION_CLOSE');
  const secondCommit = await arbiter.commit((r) => r);
  assert.equal(secondCommit, undefined); // no second write, no disagreement between "committed" and any later reason
});

// ============================================================
// isSealing(): the synchronous signal an external fault trigger (e.g. a
// reconnect-exhaustion handler) must consult before calling
// StrategyHostLifecycle.fault() directly, so that a racing fault can never
// flip the *host's own* state to FAULTED once this arbiter has already
// frozen (or started freezing) a different outcome.
// ============================================================

test('isSealing() is false before any commit() call, even after propose()', () => {
  const arbiter = new StrategyTerminalOutcomeArbiter();
  assert.equal(arbiter.isSealing(), false);
  arbiter.propose('EOD_NSE_SESSION_CLOSE', 'VALID_COMPLETED');
  assert.equal(arbiter.isSealing(), false);
});

test('isSealing() flips true synchronously the instant commit() is invoked, before the durable write even resolves', async () => {
  const arbiter = new StrategyTerminalOutcomeArbiter();
  arbiter.propose('EOD_NSE_SESSION_CLOSE', 'VALID_COMPLETED');
  const gate = new Promise<void>((resolve) => setTimeout(resolve, 5));
  const commitPromise = arbiter.commit(async (reason) => { await gate; return reason; });
  assert.equal(arbiter.isSealing(), true); // true immediately, synchronously, while the write is still in flight
  assert.equal(arbiter.isCommitted(), false); // but not yet committed -- the write has not resolved
  await commitPromise;
  assert.equal(arbiter.isSealing(), true); // remains true after the write resolves too
  assert.equal(arbiter.isCommitted(), true);
});

test('propose() is a no-op once isSealing() is true, even before the write resolves', async () => {
  const arbiter = new StrategyTerminalOutcomeArbiter();
  arbiter.propose('EOD_NSE_SESSION_CLOSE', 'VALID_COMPLETED');
  const gate = new Promise<void>((resolve) => setTimeout(resolve, 5));
  const commitPromise = arbiter.commit(async (reason) => { await gate; return reason; });
  arbiter.propose('RECONNECT_FAILED', 'FAULTED'); // races in mid-write -- must not win
  const committed = await commitPromise;
  assert.equal(committed, 'EOD_NSE_SESSION_CLOSE');
  assert.equal(arbiter.getCommittedReason(), 'EOD_NSE_SESSION_CLOSE');
});

// ============================================================
// sealAfterCloseOut(): the production finalization seam every terminal
// trigger (EOD, manual SIGINT/SIGTERM, fault) calls after its own propose(),
// used verbatim by the real V2/V4/V8 live entrypoints. Exercises Codex
// windows A/B/C/D/E/N directly against this shared seam, not a mirrored
// local harness.
// ============================================================

test('A: EOD close-out finishes, then a fault immediately BEFORE commit still wins -- FAULTED, one SUMMARY, no VALID_COMPLETED/CLEAN_SHUTDOWN', async () => {
  const arbiter = new StrategyTerminalOutcomeArbiter();
  const writes: string[] = [];
  arbiter.propose('EOD_NSE_SESSION_CLOSE', 'VALID_COMPLETED');
  const result = await arbiter.sealAfterCloseOut(
    () => { arbiter.propose('RECONNECT_FAILED', 'FAULTED'); return 'close-out-done'; }, // fault arrives inside close-out, before this seam's own commit()
    (reason) => { writes.push(reason); },
  );
  assert.equal(result, 'close-out-done');
  assert.equal(writes.length, 1);
  assert.deepEqual(writes, ['RECONNECT_FAILED']);
  assert.equal(arbiter.getCommittedReason(), 'RECONNECT_FAILED');
});

test('B: a fault proposed immediately AFTER sealAfterCloseOut has committed cannot rewrite the sealed outcome', async () => {
  const arbiter = new StrategyTerminalOutcomeArbiter();
  const writes: string[] = [];
  arbiter.propose('EOD_NSE_SESSION_CLOSE', 'VALID_COMPLETED');
  const result = await arbiter.sealAfterCloseOut(() => 'close-out-done', (reason) => { writes.push(reason); });
  arbiter.propose('RECONNECT_FAILED', 'FAULTED'); // arrives after the seal
  assert.equal(result, 'close-out-done');
  assert.deepEqual(writes, ['EOD_NSE_SESSION_CLOSE']);
  assert.equal(arbiter.getCommittedReason(), 'EOD_NSE_SESSION_CLOSE');
});

test('C: "commit() selected but not yet terminal" is not representable through sealAfterCloseOut -- the write always runs only after close-out settles', async () => {
  const arbiter = new StrategyTerminalOutcomeArbiter();
  const order: string[] = [];
  arbiter.propose('EOD_NSE_SESSION_CLOSE', 'VALID_COMPLETED');
  await arbiter.sealAfterCloseOut(
    async () => { order.push('close-out'); },
    (reason) => { order.push(`write:${reason}`); },
  );
  assert.deepEqual(order, ['close-out', 'write:EOD_NSE_SESSION_CLOSE']); // close-out is always fully ordered before the write
});

test('D: close-out throws before the seal -- FAULTED is proposed and durably wins, and the original error still propagates', async () => {
  const arbiter = new StrategyTerminalOutcomeArbiter();
  const writes: string[] = [];
  arbiter.propose('EOD_NSE_SESSION_CLOSE', 'VALID_COMPLETED');
  await assert.rejects(
    () => arbiter.sealAfterCloseOut(
      () => { throw new Error('UNSUBSCRIBE_FAILED'); },
      (reason) => { writes.push(reason); },
    ),
    /UNSUBSCRIBE_FAILED/,
  );
  assert.deepEqual(writes, ['UNSUBSCRIBE_FAILED']); // exactly one SUMMARY, sealed FAULTED with the close-out failure as the reason
  assert.equal(arbiter.getCommittedReason(), 'UNSUBSCRIBE_FAILED');
  assert.equal(arbiter.isCommitted(), true);
});

test('E: the write itself (SUMMARY append) throws -- no trustworthy committed outcome, and a second call does not fabricate a duplicate contradictory SUMMARY', async () => {
  const arbiter = new StrategyTerminalOutcomeArbiter();
  arbiter.propose('EOD_NSE_SESSION_CLOSE', 'VALID_COMPLETED');
  await assert.rejects(
    () => arbiter.sealAfterCloseOut(() => 'close-out-done', () => { throw new Error('SUMMARY_APPEND_FAILED'); }),
    /SUMMARY_APPEND_FAILED/,
  );
  assert.equal(arbiter.isCommitted(), false); // never fabricates a committed outcome from a failed write
  assert.equal(arbiter.getCommittedReason(), undefined);
});

test('N: sealAfterCloseOut runs the writer exactly once even if invoked again after a successful seal', async () => {
  const arbiter = new StrategyTerminalOutcomeArbiter();
  let writes = 0;
  arbiter.propose('EOD_NSE_SESSION_CLOSE', 'VALID_COMPLETED');
  await arbiter.sealAfterCloseOut(() => undefined, () => { writes += 1; });
  arbiter.propose('SECOND_FAULT', 'FAULTED'); // ignored -- already sealed
  await arbiter.sealAfterCloseOut(() => undefined, () => { writes += 1; });
  assert.equal(writes, 1);
});

test('close-out failure description falls back to CLOSE_OUT_FAILED for a non-Error throw, and to a custom describeFailure when supplied', async () => {
  const arbiter = new StrategyTerminalOutcomeArbiter();
  arbiter.propose('EOD_NSE_SESSION_CLOSE', 'VALID_COMPLETED');
  await assert.rejects(() => arbiter.sealAfterCloseOut(() => { throw 'not-an-error'; }, () => undefined));
  assert.equal(arbiter.getCommittedReason(), 'CLOSE_OUT_FAILED');

  const customArbiter = new StrategyTerminalOutcomeArbiter();
  customArbiter.propose('EOD_NSE_SESSION_CLOSE', 'VALID_COMPLETED');
  await assert.rejects(() => customArbiter.sealAfterCloseOut(() => { throw new Error('boom'); }, () => undefined, () => 'CUSTOM_REASON'));
  assert.equal(customArbiter.getCommittedReason(), 'CUSTOM_REASON');
});
