export type SourceBoundaryEvaluationDisposition = 'NOT_REQUIRED' | 'REQUIRED_PENDING' | 'EVALUATED' | 'LOST';

export interface SourceBoundaryEvaluationRecord {
  readonly runtimeId: string;
  readonly strategyId: string;
  readonly generationId: number;
  readonly requiredBoundary: Date;
  readonly completedCandleTime?: Date;
  readonly disposition: SourceBoundaryEvaluationDisposition;
  readonly reason: string;
}

/**
 * Smallest explicit evidence model proving whether the one required final
 * forward-strategy evaluation at the NIFTY source-completion boundary
 * (09:15-anchored session's 15:30 IST source horizon) actually ran.
 *
 * Owned per generation: require() always starts a fresh REQUIRED_PENDING
 * record for the generationId supplied -- so a stale markEvaluated()/
 * markLost() call carrying an OLDER generationId can never satisfy (or fail)
 * a newer generation's own requirement, and a newer generation's own record
 * can never be read as satisfied merely because an older generation's record
 * once was. Once a generation's own record reaches EVALUATED it is sticky
 * (terminal) for that generation: nothing can downgrade a genuinely
 * completed evaluation back to LOST/PENDING for the same generationId.
 */
export class SourceBoundaryEvaluationCoverageTracker {
  private record: SourceBoundaryEvaluationRecord | undefined;

  constructor(private readonly runtimeId: string, private readonly strategyId: string) {}

  /** Establishes (or re-establishes, for a new generation) the pending obligation. */
  require(generationId: number, requiredBoundary: Date): void {
    if (this.record?.generationId === generationId) return; // idempotent within one generation, including a genuine EVALUATED/LOST already recorded
    this.record = {
      runtimeId: this.runtimeId,
      strategyId: this.strategyId,
      generationId,
      requiredBoundary: new Date(requiredBoundary.getTime()),
      disposition: 'REQUIRED_PENDING',
      reason: 'SOURCE_BOUNDARY_EVALUATION_REQUIRED',
    };
  }

  /** Returns true only if this call's generationId matches the currently-tracked requirement. */
  markEvaluated(generationId: number, completedCandleTime: Date, reason: string): boolean {
    if (!this.record || this.record.generationId !== generationId) return false;
    if (this.record.disposition === 'EVALUATED') return true;
    this.record = { ...this.record, completedCandleTime: new Date(completedCandleTime.getTime()), disposition: 'EVALUATED', reason };
    return true;
  }

  /** No-op for a stale generationId or once already EVALUATED -- a genuinely completed evaluation can never be downgraded. */
  markLost(generationId: number, reason: string): void {
    if (!this.record || this.record.generationId !== generationId || this.record.disposition === 'EVALUATED') return;
    this.record = { ...this.record, disposition: 'LOST', reason };
  }

  /** NOT_REQUIRED both when nothing was ever required, and when the requirement on record belongs to a different (older or superseded) generation. */
  disposition(generationId: number): SourceBoundaryEvaluationDisposition {
    if (!this.record || this.record.generationId !== generationId) return 'NOT_REQUIRED';
    return this.record.disposition;
  }

  getRecord(): Readonly<SourceBoundaryEvaluationRecord> | undefined {
    return this.record ? { ...this.record } : undefined;
  }

  /** True when nothing outstanding blocks a truthful VALID_COMPLETED for `generationId`. */
  isSatisfiedFor(generationId: number): boolean {
    const disposition = this.disposition(generationId);
    return disposition === 'NOT_REQUIRED' || disposition === 'EVALUATED';
  }
}
