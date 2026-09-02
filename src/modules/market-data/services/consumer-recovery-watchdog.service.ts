/**
 * Bounded, per-consumer LOGICAL recovery watchdog (F-02).
 *
 * MarketDataRecoveryCoordinatorService's own POST-STARTUP recovery (DEGRADED ->
 * RECONNECTING -> [CONNECTED] -> BACKFILLING -> WAITING_FOR_FRESH_TICK -> READY) is unbounded on
 * its own: once the shared physical transport is healthy again, nothing forces a consumer stuck
 * mid-recovery (a hung backfill Promise, or a feed that never produces another fresh tick) to
 * ever fault. This class is the strategy-owned budget that closes that gap, entirely independent
 * of SharedMarketDataGateway's own physical ConnectionManager/breaker -- it only ever calls back
 * into the SAME consumer's own MarketDataRecoveryCoordinatorService.fault(), never anything
 * physical, so it can never open the shared gateway breaker or affect a sibling consumer.
 *
 * Episode semantics:
 * - `onStateChanged` is fed every 'stateChanged' state from the owning coordinator, but the
 *   caller must only start feeding it AFTER startup has reached RUNNING (see
 *   test-live-paper-trading.ts/test-live-v4-nifty-momentum-shadow.ts/
 *   test-live-v8-nifty-bullish-reclaim-shadow.ts, each gated on their own `startupComplete`
 *   flag) -- this watchdog is for POST-STARTUP recovery only; the existing bounded
 *   `waitUntilReady()` remains the sole owner of the cold-start bound.
 * - A "resolved" state (READY / SOURCE_COMPLETE_READY) or a terminal state (FAULTED / STOPPED /
 *   STOPPING / FAIL_CLOSED) always clears any active deadline.
 * - Any other state starts a deadline the FIRST time it is observed while unarmed. Every
 *   subsequent non-resolved, non-terminal state (RECONNECTING -> BACKFILLING ->
 *   WAITING_FOR_FRESH_TICK, a repeated physical reconnect/generation advance, etc.) while a
 *   deadline is already armed does NOT restart it -- the deadline stays anchored to the FIRST
 *   unresolved transition of that logical episode.
 * - Expiration calls `onTimeout` exactly once per episode. A stale timer belonging to an episode
 *   that has already cleared (superseded by a later episode, or resolved) can never fire it --
 *   each episode owns a monotonic token, checked before invoking the callback.
 */

export interface ConsumerRecoveryWatchdogOptions {
  /** Total budget (ms) an unresolved post-startup recovery episode may remain unresolved. */
  budgetMs: number;
  /** Invoked exactly once when an episode's deadline elapses. Expected to call recovery.fault(reason). */
  onTimeout: (reason: string) => void;
  now?: () => number;
  setTimeoutFn?: (callback: () => void, delayMs: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
}

export const CONSUMER_RECOVERY_WATCHDOG_TIMEOUT_REASON = 'CONSUMER_RECOVERY_WATCHDOG_TIMEOUT';

const RESOLVED_STATES = new Set(['READY', 'SOURCE_COMPLETE_READY']);
const TERMINAL_STATES = new Set(['FAULTED', 'STOPPED', 'STOPPING', 'FAIL_CLOSED']);

export default class ConsumerRecoveryWatchdogService {
  private readonly now: () => number;
  private readonly setTimeoutFn: (callback: () => void, delayMs: number) => unknown;
  private readonly clearTimeoutFn: (handle: unknown) => void;
  private armed = false;
  private episodeToken = 0;
  private timerHandle: unknown;

  constructor(private readonly options: ConsumerRecoveryWatchdogOptions) {
    if (!Number.isFinite(options.budgetMs) || options.budgetMs <= 0) throw new Error('ConsumerRecoveryWatchdogService: budgetMs must be a positive finite number.');
    this.now = options.now ?? Date.now;
    this.setTimeoutFn = options.setTimeoutFn ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.clearTimeoutFn = options.clearTimeoutFn ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));
  }

  /** Feed one coordinator 'stateChanged' state. Safe to call for every state once armed post-startup. */
  onStateChanged(state: string): void {
    if (RESOLVED_STATES.has(state) || TERMINAL_STATES.has(state)) {
      this.clear();
      return;
    }
    if (this.armed) return; // Same unresolved episode continuing -- deadline stays anchored.
    this.start();
  }

  /** Explicit stop (e.g. strategy shutdown): cancels any pending timer so it can never fire after termination. */
  stop(): void {
    this.clear();
  }

  isArmed(): boolean {
    return this.armed;
  }

  private start(): void {
    this.armed = true;
    const token = ++this.episodeToken;
    this.timerHandle = this.setTimeoutFn(() => {
      if (token !== this.episodeToken || !this.armed) return; // Superseded/cleared -- never fires late.
      this.armed = false;
      this.timerHandle = undefined;
      this.options.onTimeout(CONSUMER_RECOVERY_WATCHDOG_TIMEOUT_REASON);
    }, this.options.budgetMs);
  }

  private clear(): void {
    this.episodeToken += 1; // Invalidates any in-flight timer callback for the episode just closed.
    this.armed = false;
    if (this.timerHandle !== undefined) {
      this.clearTimeoutFn(this.timerHandle);
      this.timerHandle = undefined;
    }
  }
}
