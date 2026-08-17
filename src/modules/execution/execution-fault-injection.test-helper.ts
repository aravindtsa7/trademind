/** Test-only deterministic failpoint implementation. Never imported by runtime code. */
import { ExecutionFailpoint, ExecutionFaultInjector } from './execution-fault-injection';

export class InjectedExecutionFault extends Error {
  constructor(public readonly point: ExecutionFailpoint) {
    super(`Injected execution fault at ${point}.`);
    this.name = 'InjectedExecutionFault';
  }
}

export class DeterministicExecutionFaultInjector implements ExecutionFaultInjector {
  private readonly armed = new Map<ExecutionFailpoint, number>();
  readonly hits: ExecutionFailpoint[] = [];

  arm(point: ExecutionFailpoint, count = 1): void {
    if (!Number.isInteger(count) || count <= 0) throw new Error('Failpoint count must be a positive integer.');
    this.armed.set(point, count);
  }

  hit(point: ExecutionFailpoint): void {
    this.hits.push(point);
    const remaining = this.armed.get(point) ?? 0;
    if (remaining <= 0) return;
    if (remaining === 1) this.armed.delete(point); else this.armed.set(point, remaining - 1);
    throw new InjectedExecutionFault(point);
  }
}
