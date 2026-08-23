/**
 * Terminal-reason class precedence for {@link StrategyTerminalOutcomeArbiter}.
 * Mirrors resolveSessionOutcome()'s own precedence
 * (src/modules/research-validation/services/forward-validation.service.ts):
 * RECONCILIATION_REQUIRED > FAULTED > INVALID_DATA > MANUAL_STOP > VALID_COMPLETED.
 *
 * RECONCILIATION_REQUIRED and INVALID_DATA are not something any caller here
 * proposes: they are durable-state facts (an open position that could not be
 * closed; a startup/warmup gate that never passed) that resolveSessionOutcome()
 * already re-evaluates fresh, from its own flags, at the moment the arbiter's
 * `write` callback actually runs -- never a race between which caller reached
 * a line of code first. The only genuine race this arbiter resolves is which
 * terminal TRIGGER reached the host first: a normal EOD/manual-stop trigger,
 * or a racing fault.
 */
export type StrategyTerminalReasonClass = 'RECONCILIATION_REQUIRED' | 'FAULTED' | 'INVALID_DATA' | 'MANUAL_STOP' | 'VALID_COMPLETED';

const reasonClassPrecedence: Record<StrategyTerminalReasonClass, number> = {
  RECONCILIATION_REQUIRED: 5,
  FAULTED: 4,
  INVALID_DATA: 3,
  MANUAL_STOP: 2,
  VALID_COMPLETED: 1,
};

function describeCloseOutFailure(error: unknown): string {
  return error instanceof Error ? error.message : 'CLOSE_OUT_FAILED';
}

/**
 * The one production seam that separates a terminal trigger's own close-out
 * work (draining durable exits, closing positions, unsubscribing, disconnecting)
 * from the single durable outcome write for a session (the SUMMARY record and
 * any CLEAN_SHUTDOWN event).
 *
 * Every terminal trigger (EOD, manual SIGINT/SIGTERM, fault) is expected to:
 *   1. propose() its own reason immediately, before starting any close-out work;
 *   2. perform whatever close-out work it owns via sealAfterCloseOut() (this
 *      arbiter has no opinion on what that work is, or whether more than one
 *      trigger's work runs -- an already-started EOD close-out cannot be
 *      un-run just because a fault later wins the outcome);
 *   3. let sealAfterCloseOut() commit the durable outcome only once that
 *      close-out work has finished (or escalate to FAULTED and still commit,
 *      if it threw) -- never before.
 *
 * While no commit() has started, propose() may keep escalating the pending
 * reason to a higher-precedence class (a racing fault can still promote the
 * outcome to FAULTED). commit() captures whatever the pending reason is at
 * the instant it is called and locks it in synchronously, before its `write`
 * callback ever runs -- so a fault that only arrives after commit() has begun
 * is a genuine post-commit fault: propose() and commit() both become no-ops
 * for it, and the already-committed result is returned unchanged. The writer
 * itself therefore runs at most once for the lifetime of one arbiter.
 *
 * isSealing() flips true synchronously the instant commit() is invoked --
 * before its (possibly slow) durable write even starts -- and is the signal
 * external fault triggers (e.g. a reconnect-exhaustion handler) must consult
 * before calling StrategyHostLifecycle.fault() directly: this arbiter has
 * already frozen (or is in the middle of freezing) an outcome by then, and a
 * racing fault() call would otherwise still be free to flip the *host's own*
 * state to FAULTED even though the durable record it is about to (or already
 * did) write says something else -- the exact "journal VALID_COMPLETED, host
 * FAULTED" disagreement this arbiter exists to prevent. Once isSealing() is
 * true, that external trigger must skip host.fault() entirely: the outcome is
 * no longer this trigger's to decide.
 */
export class StrategyTerminalOutcomeArbiter {
  private pendingReason?: string;
  private pendingClass?: StrategyTerminalReasonClass;
  private sealing = false;
  private committing?: Promise<unknown>;
  private committedReason?: string;

  /** Registers (or escalates to) a terminal reason. Ignored once commit() has started or finished. */
  propose(reason: string, reasonClass: StrategyTerminalReasonClass): void {
    if (this.sealing) return;
    if (this.pendingClass === undefined || reasonClassPrecedence[reasonClass] > reasonClassPrecedence[this.pendingClass]) {
      this.pendingReason = reason;
      this.pendingClass = reasonClass;
    }
  }

  /**
   * True from the synchronous instant commit() is first invoked -- even
   * before its durable write begins -- and forever after. See the class doc
   * above: an external fault trigger must treat this as "the outcome is
   * already spoken for" and skip calling StrategyHostLifecycle.fault().
   */
  isSealing(): boolean {
    return this.sealing;
  }

  /** True once commit() has produced a durable outcome. */
  isCommitted(): boolean {
    return this.committedReason !== undefined;
  }

  /** The reason actually used by the durable write, once committed. */
  getCommittedReason(): string | undefined {
    return this.committedReason;
  }

  /**
   * Commits exactly once. The first caller to invoke commit() captures the
   * highest-precedence proposed reason at that instant and runs `write` with
   * it; a later commit() call (from a second terminal trigger, including a
   * post-commit fault) returns `undefined` without re-invoking `write` and
   * without writing a second SUMMARY/CLEAN_SHUTDOWN. Throws if no propose()
   * call has ever been made -- callers are expected to propose before
   * committing, never to commit blind.
   */
  async commit<T>(write: (reason: string) => Promise<T> | T): Promise<T | undefined> {
    if (this.committedReason !== undefined) return undefined;
    if (this.committing) return this.committing as Promise<T>;
    if (this.pendingReason === undefined) throw new Error('StrategyTerminalOutcomeArbiter.commit() called before any propose().');
    this.sealing = true;
    const reason = this.pendingReason;
    this.committing = (async (): Promise<T> => {
      const result = await write(reason);
      this.committedReason = reason;
      return result;
    })();
    try {
      return await (this.committing as Promise<T>);
    } finally {
      this.committing = undefined;
    }
  }

  /**
   * THE production finalization seam every terminal trigger (EOD, manual
   * SIGINT/SIGTERM, fault) is expected to call, exactly once its own
   * propose() has run: performs the caller-owned fallible close-out
   * (unsubscribe, disconnect, drain durable exits, stop adapters, ...) and
   * seals the durable outcome only after that close-out has finished --
   * never before, so a mid-close-out failure can never leave a durably
   * committed VALID_COMPLETED SUMMARY next to a host that goes on to fault.
   *
   * If `closeOut` throws, the failure is escalated to FAULTED (outranking
   * whatever this trigger's own reason was), the durable outcome is still
   * sealed with that escalated reason (so a session that failed to close out
   * cleanly is never left without a terminal SUMMARY), and the original
   * error is rethrown -- so a caller wiring this into an onEod/onShutdown
   * hook still rejects and lets StrategyHostLifecycle reach FAULTED.
   */
  async sealAfterCloseOut<T>(
    closeOut: () => Promise<T> | T,
    write: (reason: string) => Promise<void> | void,
    describeFailure: (error: unknown) => string = describeCloseOutFailure,
  ): Promise<T> {
    let result: T;
    try {
      result = await closeOut();
    } catch (error) {
      this.propose(describeFailure(error), 'FAULTED');
      await this.commit(write);
      throw error;
    }
    await this.commit(write);
    return result;
  }
}
