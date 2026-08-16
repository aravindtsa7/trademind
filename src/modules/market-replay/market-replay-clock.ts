/** Replay-only clock. No replay component needs wall-clock time. */
export interface ReplayClock {
  now(): Date;
  advanceTo(value: Date): void;
  setTimeout(callback: () => void, delayMs: number): number;
  clearTimeout(timerId: number): void;
}

interface ScheduledTimer { id: number; atMs: number; callback: () => void; }

/** Clock and timers advance only when a replay event advances them. */
export class DeterministicReplayClock implements ReplayClock {
  private current = new Date(0);
  private nextTimerId = 1;
  private readonly timers = new Map<number, ScheduledTimer>();

  now(): Date { return new Date(this.current.getTime()); }

  advanceTo(value: Date): void {
    if (value.getTime() < this.current.getTime()) throw new Error('Replay events must be chronological.');
    while (true) {
      const timer = this.nextTimerAtOrBefore(value.getTime());
      if (!timer) break;
      this.timers.delete(timer.id);
      this.current = new Date(timer.atMs);
      timer.callback();
    }
    this.current = new Date(value.getTime());
  }

  setTimeout(callback: () => void, delayMs: number): number {
    if (!Number.isFinite(delayMs) || delayMs < 0) throw new Error('Replay timer delay must be a non-negative finite value.');
    const id = this.nextTimerId++;
    this.timers.set(id, { id, atMs: this.current.getTime() + delayMs, callback });
    return id;
  }

  clearTimeout(timerId: number): void { this.timers.delete(timerId); }

  private nextTimerAtOrBefore(atMs: number): ScheduledTimer | undefined {
    return [...this.timers.values()]
      .filter((timer) => timer.atMs <= atMs)
      .sort((left, right) => left.atMs - right.atMs || left.id - right.id)[0];
  }
}
