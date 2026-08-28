import { join } from 'path';
import { fileExists, readFileBuffer, writeBufferAtomic } from '../domain/atomic-file-writer';
import { ResearchYearRunPlan, ResearchYearRunRecord } from '../domain/research-year-run.types';

export const DEFAULT_RESEARCH_YEAR_RUN_CHECKPOINT_ROOT = 'artifacts/research-lake/year-runs';

/**
 * B-F8 orchestration run checkpoint persistence. Deliberately NOT the B-F5
 * dataset manifest / B-F6 storage descriptor -- this is orchestration state
 * (which stages/sessions this year run has durably completed and verified),
 * kept structurally separate from B-F5's authoritative dataset identity
 * (task section 11).
 *
 * The checkpoint path is a deterministic, collision-safe function of the
 * plan's own content-addressed `planSemanticIdentity` (task section 11:
 * "deterministic, collision-safe path based on actual existing
 * conventions") -- the SAME full-checksum-in-path convention B-F6 already
 * established (`parquetDatasetDirectory`). Two runs with an identical
 * `ResearchYearRunRequest` (and identically-resolving option universe)
 * always read/write the SAME checkpoint file, which is exactly what makes
 * resume possible.
 *
 * Writes are atomic (task section 12): a checkpoint is metadata ABOUT
 * already-independently-verified session/stage outputs (never itself the
 * thing being verified), so it uses the same `writeBufferAtomic` primitive
 * B-F6's own storage descriptor uses -- no read-back verification step is
 * needed before a checkpoint write becomes trusted.
 */
export default class ResearchYearRunCheckpointService {
  constructor(private readonly checkpointRoot: string = DEFAULT_RESEARCH_YEAR_RUN_CHECKPOINT_ROOT) {}

  checkpointPath(plan: ResearchYearRunPlan): string {
    return join(this.checkpointRoot, plan.scope, `${plan.year}_${plan.fromDate}_${plan.toDate}_${plan.planSemanticIdentity}.json`);
  }

  /** Returns `null` when no checkpoint exists yet for this exact plan identity -- never fabricates a "first run" record. */
  load(plan: ResearchYearRunPlan): ResearchYearRunRecord | null {
    const path = this.checkpointPath(plan);
    if (!fileExists(path)) return null;
    return JSON.parse(readFileBuffer(path).toString('utf8')) as ResearchYearRunRecord;
  }

  save(record: ResearchYearRunRecord): void {
    const path = this.checkpointPath(record.plan);
    writeBufferAtomic(path, Buffer.from(`${JSON.stringify(record, null, 2)}\n`, 'utf8'));
  }
}
