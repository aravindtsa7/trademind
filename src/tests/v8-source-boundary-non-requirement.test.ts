import assert from 'node:assert/strict';
import test from 'node:test';
import MarketDataRecoveryCoordinatorService from '../modules/market-data/services/market-data-recovery-coordinator.service';
import { nifty1mSourceCompletionBoundary, NIFTY_1M_SOURCE_HORIZON_END_MINUTE } from '../modules/historical-candles/utils/historical-session-completeness.util';

/**
 * A7-H6: V8 assessment. Terra's blocker is specific to strategies whose final aligned
 * live-construction boundary lands EXACTLY on the NIFTY source-completion boundary (15:30
 * IST) -- a minute NIFTY_INDEX never publishes a candle for, so no live tick can ever resolve
 * it. V2 (5-minute-aligned) and V4 (3-minute-aligned, LCM(3,5)=15) both hit that exact minute,
 * because 375 (the 09:15-15:29 inclusive row count) is evenly divisible by both 5 and 3.
 *
 * V8 is 2-minute-aligned and 375 is NOT evenly divisible by 2: the session's true final minute
 * (15:29) is a stray, unpaired offset that can never complete a 2-minute bucket at all -- the
 * last bucket V8's OWN 09:15-anchored grid can ever complete is 15:27-15:28, one full minute
 * BEFORE the dead 15:30 boundary. Its worst-case (latest reachable) live-construction boundary
 * is therefore 15:29 -- a minute NIFTY_INDEX genuinely still publishes ticks for -- so a live
 * tick can always resolve it the same way any ordinary mid-session boundary is resolved. This
 * is proven directly against the coordinator's real establishLiveConstructionBoundary() logic
 * below, not merely asserted from the arithmetic in this doc comment.
 *
 * Conclusion: V8 requires NO new source-boundary evaluation path. Its existing
 * pendingReconciliation / boundaryReconciliationObligation / completePendingBoundaryReconciliation
 * machinery (already exercised by v8-cold-start-continuity.integration.test.ts) is untouched by
 * A7-H6, and its trailing-frame/fail-closed semantics for a genuinely silent feed are preserved
 * exactly as before.
 */

const NIFTY = 'NSE_INDEX|Nifty 50';
const openAt = new Date('2026-08-24T09:15:00+05:30');
const closeAt = new Date('2026-08-24T15:40:00+05:30');

test('A7-H6 V8: the 09:15-15:29 session row count (375) is evenly divisible by V2 (5m) and V4 (3m) alignment, but NOT by V8 (2m) alignment', () => {
  const sessionMinutes = NIFTY_1M_SOURCE_HORIZON_END_MINUTE - (9 * 60 + 15) + 1; // 09:15 through 15:29 inclusive
  assert.equal(sessionMinutes, 375);
  assert.equal(sessionMinutes % 5, 0, 'V2 5-minute alignment divides evenly -- its final bucket (15:25-15:29) ends exactly at the dead 15:30 boundary');
  assert.equal(sessionMinutes % 3, 0, 'V4 3-minute alignment divides evenly -- its final bucket (15:27-15:29) ends exactly at the dead 15:30 boundary');
  assert.notEqual(sessionMinutes % 2, 0, 'V8 2-minute alignment does NOT divide evenly -- 15:29 is a stray minute that can never complete a 2-minute bucket at all');
});

test('A7-H6 V8: the latest reachable aligned live-construction boundary is 15:29 (target 15:28) -- inside the actively-ticking window, so an ordinary live tick (never a fabricated 15:30 one) resolves it, exactly like any other mid-session boundary', async () => {
  let recoveredTarget: Date | undefined;
  let establishedBoundary: Date | undefined;
  let blockedThrough: Date | undefined;
  let now = new Date('2026-08-24T15:27:05+05:30').getTime();
  const coordinator = new MarketDataRecoveryCoordinatorService<{ latestMinute: Date }>({
    nowMs: () => now,
    isMarketSession: (value) => value.getTime() >= openAt.getTime() && value.getTime() < closeAt.getTime(),
    getSessionBoundary: () => ({ openAt, closeAt }),
    getLastSeededCompletedMinute: () => new Date('2026-08-24T15:20:00+05:30'),
    liveConstructionAlignmentMinutes: 2,
    getSourceCompletionBoundary: nifty1mSourceCompletionBoundary,
    getRecoveredCompletedMinute: (data) => data?.latestMinute,
    backfill: async (target) => {
      recoveredTarget = target;
      return { ready: true, reason: 'OK', missingMinutes: 0, duplicateMinutes: 0, recoveryData: { latestMinute: target ?? new Date() } };
    },
    onLiveConstructionBoundary: (boundary) => { establishedBoundary = boundary; },
    onLiveConstructionUnavailable: (sessionClose) => { blockedThrough = sessionClose; },
  });
  // A reconnect landing inside the final complete 2m bucket (15:27-15:28) -- the latest moment
  // a reconnect can still land on a bucket boundary V8's own grid can complete.
  coordinator.handleUnexpectedDisconnect({ generationId: 0 });
  coordinator.handleReconnected({ generationId: 1 });

  assert.equal(blockedThrough, undefined, 'a reconnect at 15:27 must still find a safe same-session handoff');
  assert.equal(establishedBoundary?.toISOString(), new Date('2026-08-24T15:29:00+05:30').toISOString());
  // 15:29 is strictly before the NIFTY source-completion boundary (15:30): NIFTY_INDEX still
  // publishes ticks for this minute, so a live tick can resolve this boundary the ordinary way.
  assert.equal(establishedBoundary!.getTime() < nifty1mSourceCompletionBoundary(establishedBoundary!).getTime(), true);

  // NIFTY_INDEX genuinely still ticks at 15:29 (unlike 15:30, which V2/V4 depend on and which
  // never exists) -- an ordinary live tick, not a source-boundary trigger, resolves this.
  now = new Date('2026-08-24T15:29:00+05:30').getTime();
  coordinator.handleLiveTick({ sourceTimestamp: new Date(now), receivedAt: new Date(now), generationId: 1 });
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  assert.equal(recoveredTarget?.toISOString(), new Date('2026-08-24T15:28:00+05:30').toISOString());
});

test('A7-H6 V8: a reconnect landing in the dead final minute (15:29, after V8\'s own last completable bucket) has no safe same-session handoff and fails closed exactly like V2/V4 do -- this is the pre-existing, untouched fail-closed path, not a new gap', () => {
  let backfillCalls = 0;
  let blockedThrough: Date | undefined;
  const coordinator = new MarketDataRecoveryCoordinatorService<{ latestMinute: Date }>({
    nowMs: () => new Date('2026-08-24T15:29:05+05:30').getTime(),
    isMarketSession: (value) => value.getTime() >= openAt.getTime() && value.getTime() < closeAt.getTime(),
    getSessionBoundary: () => ({ openAt, closeAt }),
    getLastSeededCompletedMinute: () => new Date('2026-08-24T15:20:00+05:30'),
    liveConstructionAlignmentMinutes: 2,
    getSourceCompletionBoundary: nifty1mSourceCompletionBoundary,
    getRecoveredCompletedMinute: (data) => data?.latestMinute,
    backfill: async () => { backfillCalls += 1; return { ready: true, reason: 'OK', missingMinutes: 0, duplicateMinutes: 0, recoveryData: { latestMinute: new Date() } }; },
    onLiveConstructionUnavailable: (sessionClose) => { blockedThrough = sessionClose; },
  });
  coordinator.handleUnexpectedDisconnect({ generationId: 0 });
  coordinator.handleReconnected({ generationId: 1 });

  assert.equal(coordinator.getState(), 'FAULTED');
  assert.equal(blockedThrough?.toISOString(), closeAt.toISOString());
  assert.equal(backfillCalls, 0, 'no REST call may ever request a NIFTY 1m minute beyond 15:29');
});
