import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { DurableExecutionState, ExecutionOrder } from './execution.types';

export interface ExecutionRepository {
  load(sessionDate: string): DurableExecutionState | undefined;
  loadAll(): DurableExecutionState[];
  save(state: DurableExecutionState): void;
}

/** Atomic local durable adapter. Prisma tables are supplied for production
 * deployment; this adapter preserves the synchronous runtime/replay contract
 * and is deliberately never a source of broker execution. */
export class FileExecutionRepository implements ExecutionRepository {
  constructor(private readonly root = 'artifacts/execution-ledger') {}
  load(sessionDate: string): DurableExecutionState | undefined {
    const path = this.path(sessionDate); if (!existsSync(path)) return undefined;
    return parseState(readFileSync(path, 'utf8'));
  }
  loadAll(): DurableExecutionState[] {
    // State is session addressed; callers that need all sessions call the
    // explicit repository implementation in production. Keeping this bounded
    // prevents an unbounded filesystem scan on a live callback.
    return [];
  }
  save(state: DurableExecutionState): void {
    const path = this.path(state.sessionDate); const temporary = `${path}.${process.pid}.tmp`;
    mkdirSync(dirname(path), { recursive: true }); writeFileSync(temporary, JSON.stringify(state), 'utf8'); renameSync(temporary, path);
  }
  private path(sessionDate: string): string { return resolve(process.cwd(), this.root, `${sessionDate}.json`); }
}

export class InMemoryExecutionRepository implements ExecutionRepository {
  private readonly states = new Map<string, DurableExecutionState>();
  load(sessionDate: string): DurableExecutionState | undefined { const state = this.states.get(sessionDate); return state ? clone(state) : undefined; }
  loadAll(): DurableExecutionState[] { return [...this.states.values()].map(clone); }
  save(state: DurableExecutionState): void { this.states.set(state.sessionDate, clone(state)); }
}

function parseState(raw: string): DurableExecutionState {
  const value = JSON.parse(raw) as DurableExecutionState;
  if (value?.schemaVersion !== 1 || !value.sessionDate || !Array.isArray(value.orders) || !value.updatedAt || value.orders.some((order) => !validOrder(order))) throw new Error('Invalid durable execution state.');
  return clone(value);
}
function validOrder(order: ExecutionOrder): boolean {
  return !!order && !!order.executionOrderId && !!order.intentId && !!order.strategyId && !!order.instrumentKey
    && Number.isInteger(order.quantity) && order.quantity > 0 && Number.isFinite(order.cumulativeFilledQuantity)
    && Number.isFinite(order.cumulativeExitQuantity) && Number.isFinite(order.remainingQuantity) && Array.isArray(order.fills) && Array.isArray(order.transitions);
}
function clone<T>(value: T): T { return structuredClone(value); }
