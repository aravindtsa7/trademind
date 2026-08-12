import { existsSync, mkdirSync, openSync, closeSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export type FinalHoldoutStatus = 'UNTOUCHED' | 'AUTHORIZED' | 'CONSUMED' | 'LEGACY_CONTAMINATED';

export interface HoldoutLedgerEntry {
  strategyId: string;
  family: string;
  researchStatus: string;
  splitManifestVersion: string;
  finalHoldoutStatus: FinalHoldoutStatus;
  firstAuthorizedAt?: string;
  consumedAt?: string;
  consumedByRunner?: string;
  notes?: string;
}

export interface HoldoutLedgerDocument {
  version: string;
  entries: HoldoutLedgerEntry[];
}

export class ResearchLedgerError extends Error {}
export class HoldoutAlreadyConsumedError extends ResearchLedgerError {}

export class PersistentHoldoutLedgerService {
  private readonly lockPath: string;

  constructor(private readonly ledgerPath = resolve(process.cwd(), 'artifacts', 'research-validation', 'research-ledger.json')) {
    this.lockPath = `${ledgerPath}.lock`;
  }

  read(): HoldoutLedgerDocument {
    if (!existsSync(this.ledgerPath)) throw new ResearchLedgerError(`Research ledger is missing: ${this.ledgerPath}`);
    try {
      const value = JSON.parse(readFileSync(this.ledgerPath, 'utf8')) as HoldoutLedgerDocument;
      if (!value || typeof value !== 'object' || !Array.isArray(value.entries)) throw new Error('entries must be an array');
      value.entries.forEach((entry) => {
        if (!entry.strategyId || !entry.finalHoldoutStatus) throw new Error('entry is missing strategyId/finalHoldoutStatus');
      });
      return value;
    } catch (error) {
      throw new ResearchLedgerError(`Research ledger is corrupt or malformed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  get(strategyId: string): HoldoutLedgerEntry {
    const entry = this.read().entries.find((candidate) => candidate.strategyId === strategyId);
    if (!entry) throw new ResearchLedgerError(`No ledger entry exists for ${strategyId}.`);
    return entry;
  }

  async consumeOnce<T>(strategyId: string, runner: string, evaluate: () => Promise<T> | T, authorized = process.env.RESEARCH_FINAL_HOLDOUT_AUTHORIZED === 'true'): Promise<T> {
    if (!authorized) throw new ResearchLedgerError('FINAL_HOLDOUT_ONCE requires RESEARCH_FINAL_HOLDOUT_AUTHORIZED=true.');
    return this.withLock(async () => {
      const document = this.read();
      const entry = document.entries.find((candidate) => candidate.strategyId === strategyId);
      if (!entry) throw new ResearchLedgerError(`No ledger entry exists for ${strategyId}.`);
      if (entry.finalHoldoutStatus === 'CONSUMED') throw new HoldoutAlreadyConsumedError(`FINAL_HOLDOUT has already been consumed for ${strategyId}.`);
      if (entry.finalHoldoutStatus === 'LEGACY_CONTAMINATED') throw new ResearchLedgerError(`FINAL_HOLDOUT is legacy-contaminated for ${strategyId}; it cannot be consumed as clean holdout.`);
      const now = new Date().toISOString();
      entry.finalHoldoutStatus = 'AUTHORIZED';
      entry.firstAuthorizedAt ??= now;
      this.write(document);
      const result = await evaluate();
      entry.finalHoldoutStatus = 'CONSUMED';
      entry.consumedAt = new Date().toISOString();
      entry.consumedByRunner = runner;
      this.write(document);
      return result;
    });
  }

  private async withLock<T>(callback: () => Promise<T>): Promise<T> {
    mkdirSync(dirname(this.ledgerPath), { recursive: true });
    const deadline = Date.now() + 10_000;
    while (true) {
      try {
        const descriptor = openSync(this.lockPath, 'wx');
        closeSync(descriptor);
        break;
      } catch (error) {
        if (Date.now() >= deadline) throw new ResearchLedgerError(`Could not acquire research ledger lock: ${error instanceof Error ? error.message : String(error)}`);
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
      }
    }
    try { return await callback(); } finally { if (existsSync(this.lockPath)) unlinkSync(this.lockPath); }
  }

  private write(document: HoldoutLedgerDocument): void {
    mkdirSync(dirname(this.ledgerPath), { recursive: true });
    const temporary = `${this.ledgerPath}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`);
    renameSync(temporary, this.ledgerPath);
  }
}

export default PersistentHoldoutLedgerService;
