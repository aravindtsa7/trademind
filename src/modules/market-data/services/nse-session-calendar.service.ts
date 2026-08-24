/**
 * Single local source of truth for runtime NSE session boundaries. The default
 * is deliberately data-free: holidays and exceptional sessions are supplied
 * as deterministic local overrides when the project is ready to maintain them.
 */
export const NSE_TIME_ZONE = 'Asia/Kolkata';
export const NSE_DERIVATIVES_NORMAL_SESSION = Object.freeze({ openIst: '09:15', closeIst: '15:40' });

export interface NseSessionOverride {
  readonly closed?: boolean;
  readonly openIst?: string;
  readonly closeIst?: string;
  readonly note?: string;
}

export interface NseSessionBoundary {
  readonly tradingDate: string;
  readonly isTradingDay: boolean;
  readonly openIst: string;
  readonly closeIst: string;
  readonly openMinute: number;
  readonly closeMinute: number;
  readonly openAt: Date;
  readonly closeAt: Date;
  readonly note?: string;
}

export interface NseSessionCalendarOptions {
  readonly overrides?: Readonly<Record<string, NseSessionOverride>>;
}

const formatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: NSE_TIME_ZONE,
  year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});

/** Local, deterministic calendar; no network calendar dependency is used. */
export class NseSessionCalendar {
  private readonly overrides: Readonly<Record<string, NseSessionOverride>>;

  constructor(options: NseSessionCalendarOptions = {}) {
    this.overrides = Object.freeze({ ...(options.overrides ?? {}) });
  }

  boundaryFor(value: Date): NseSessionBoundary {
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw new Error('Session boundary requires a valid Date.');
    const parts = istParts(value); const override = this.overrides[parts.date];
    const openIst = override?.openIst ?? NSE_DERIVATIVES_NORMAL_SESSION.openIst;
    const closeIst = override?.closeIst ?? NSE_DERIVATIVES_NORMAL_SESSION.closeIst;
    const openMinute = parseIstClock(openIst); const closeMinute = parseIstClock(closeIst);
    if (closeMinute <= openMinute) throw new Error(`Invalid NSE session override for ${parts.date}: close must follow open.`);
    const isTradingDay = parts.weekday !== 'Sat' && parts.weekday !== 'Sun' && override?.closed !== true;
    return Object.freeze({
      tradingDate: parts.date,
      isTradingDay,
      openIst,
      closeIst,
      openMinute,
      closeMinute,
      openAt: istDateTime(parts.date, openIst),
      closeAt: istDateTime(parts.date, closeIst),
      ...(override?.note ? { note: override.note } : {}),
    });
  }

  isWithinSession(value: Date): boolean {
    const boundary = this.boundaryFor(value); const minute = istParts(value).minute;
    return boundary.isTradingDay && minute >= boundary.openMinute && minute < boundary.closeMinute;
  }

  isAtOrAfterClose(value: Date): boolean {
    const boundary = this.boundaryFor(value);
    return boundary.isTradingDay && value.getTime() >= boundary.closeAt.getTime();
  }

  millisecondsUntilClose(value: Date): number {
    const boundary = this.boundaryFor(value);
    if (!boundary.isTradingDay) return 0;
    return Math.max(0, boundary.closeAt.getTime() - value.getTime());
  }
}

export const nseSessionCalendar = new NseSessionCalendar();
export const isWithinNseSession = (value: Date): boolean => nseSessionCalendar.isWithinSession(value);
export const isAtOrAfterNseSessionClose = (value: Date): boolean => nseSessionCalendar.isAtOrAfterClose(value);
export const millisecondsUntilNseSessionClose = (value: Date): number => nseSessionCalendar.millisecondsUntilClose(value);

export interface NseSessionClock {
  now(): Date;
  setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  clearTimeout(timer: ReturnType<typeof setTimeout>): void;
}

const systemClock: NseSessionClock = { now: () => new Date(), setTimeout, clearTimeout };

/** Idempotent async latch shared by wall-clock timers and late market events. */
export class NseSessionEodCoordinator {
  private completion: Promise<void> | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly calendar: NseSessionCalendar = nseSessionCalendar, private readonly clock: NseSessionClock = systemClock) {}

  runOnce(at: Date, action: () => Promise<void> | void): Promise<boolean> {
    if (!this.calendar.isAtOrAfterClose(at)) return Promise.resolve(false);
    if (!this.completion) this.completion = Promise.resolve().then(action);
    return this.completion.then(() => true);
  }

  schedule(action: () => Promise<void> | void): ReturnType<typeof setTimeout> {
    this.cancelScheduled();
    return this.armTimer(action, this.calendar.millisecondsUntilClose(this.clock.now()));
  }

  cancelScheduled(): void {
    if (!this.timer) return;
    this.clock.clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** Sole owner of `this.timer`; arms exactly one live timer per call. */
  private armTimer(action: () => Promise<void> | void, delayMs: number): ReturnType<typeof setTimeout> {
    let fired = false;
    const handle = this.clock.setTimeout(() => {
      // A cleared/replaced timer's captured closure must never act again,
      // even if a test or a stale platform callback invokes it more than
      // once -- only the first live firing of this specific timer may run.
      if (fired) return;
      fired = true;
      this.timer = undefined;
      this.handleFired(action);
    }, delayMs);
    handle.unref?.();
    this.timer = handle;
    return handle;
  }

  /**
   * The wall clock can observe a firing that is a few hundred milliseconds
   * short of the canonical IST close (clock adjustment, a hostile/replay
   * clock, or borderline scheduling), which must never silently drop EOD.
   * Re-arm exactly one follow-up timer for the remaining delay instead.
   */
  private handleFired(action: () => Promise<void> | void): void {
    const now = this.clock.now();
    if (this.calendar.isAtOrAfterClose(now)) {
      void this.runOnce(now, action);
      return;
    }
    const remaining = this.calendar.millisecondsUntilClose(now);
    // millisecondsUntilClose is 0 on a non-trading day (no close boundary
    // exists there), which would otherwise re-arm at zero delay forever;
    // only a genuine positive remaining delay may re-arm.
    if (remaining <= 0) return;
    this.armTimer(action, remaining);
  }
}

/**
 * One-shot trigger for an arbitrary fixed wall-clock instant (e.g. the NIFTY
 * source-completion boundary), independent of NseSessionEodCoordinator's own
 * close-anchored scheduling. Shares its NseSessionClock injection point so
 * tests can drive both with the same fake clock.
 *
 * `armAt()` fires `action` at most once for the lifetime of an instance,
 * self-corrects exactly like NseSessionEodCoordinator when the wall clock
 * wakes it a little early, and is safe to `cancel()` before or after it has
 * fired -- cancel() after firing is simply a no-op, and armAt() after either
 * firing or cancelling is also a no-op (this trigger is genuinely one-shot,
 * not re-armable).
 */
export class OneShotWallClockTrigger {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private fired = false;
  private cancelled = false;

  constructor(private readonly clock: NseSessionClock = systemClock) {}

  armAt(at: Date, action: () => Promise<void> | void): void {
    if (this.fired || this.cancelled || this.timer !== undefined) return;
    this.armTimer(at, action);
  }

  cancel(): void {
    this.cancelled = true;
    if (this.timer !== undefined) {
      this.clock.clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  hasFired(): boolean {
    return this.fired;
  }

  private armTimer(at: Date, action: () => Promise<void> | void): void {
    const delayMs = Math.max(0, at.getTime() - this.clock.now().getTime());
    const handle = this.clock.setTimeout(() => {
      this.timer = undefined;
      if (this.fired || this.cancelled) return;
      const now = this.clock.now();
      if (now.getTime() < at.getTime()) {
        // Woken a little early (clock drift/borderline scheduling): re-arm for the
        // remaining delay instead of firing early or silently dropping the trigger.
        this.armTimer(at, action);
        return;
      }
      this.fired = true;
      void action();
    }, delayMs);
    handle.unref?.();
    this.timer = handle;
  }
}

function istParts(value: Date): { date: string; weekday: string; minute: number } {
  const parts = Object.fromEntries(formatter.formatToParts(value).map((part) => [part.type, part.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, weekday: parts.weekday, minute: Number(parts.hour) * 60 + Number(parts.minute) };
}

function parseIstClock(value: string): number {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) throw new Error(`Invalid IST clock value: ${value}.`);
  const hour = Number(match[1]); const minute = Number(match[2]);
  if (hour > 23 || minute > 59) throw new Error(`Invalid IST clock value: ${value}.`);
  return hour * 60 + minute;
}

function istDateTime(date: string, time: string): Date {
  return new Date(`${date}T${time}:00+05:30`);
}
