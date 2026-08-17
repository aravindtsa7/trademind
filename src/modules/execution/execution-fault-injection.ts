/**
 * Explicit deterministic failure seams for acceptance tests. Production uses
 * the exported no-op implementation; there is deliberately no environment
 * variable or runtime switch that can arm a failpoint.
 */
export const EXECUTION_FAILPOINTS = [
  'AFTER_SIGNAL_BEFORE_RISK',
  'AFTER_RISK_APPROVAL_BEFORE_EXECUTION',
  'AFTER_FILL_ESTIMATE_BEFORE_DB_TRANSACTION',
  'DURING_ENTRY_DB_TRANSACTION',
  'AFTER_ENTRY_DB_COMMIT_BEFORE_LOCAL_ACK',
  'BEFORE_EXIT_DB_TRANSACTION',
  'DURING_EXIT_DB_TRANSACTION',
  'AFTER_EXIT_DB_COMMIT_BEFORE_LOCAL_ACK',
  'DURING_RECONCILIATION',
  'DURING_EOD_EXIT',
  'DURING_SHUTDOWN_DRAIN',
] as const;

export type ExecutionFailpoint = typeof EXECUTION_FAILPOINTS[number];

export interface ExecutionFaultInjector {
  hit(point: ExecutionFailpoint, context?: Readonly<Record<string, unknown>>): void | Promise<void>;
}

/** Safe normal-runtime default. It has no configuration surface. */
export const noExecutionFaults: ExecutionFaultInjector = Object.freeze({ hit: (): void => undefined });
