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
    this.timer = this.clock.setTimeout(() => {
      this.timer = undefined;
      void this.runOnce(this.clock.now(), action);
    }, this.calendar.millisecondsUntilClose(this.clock.now()));
    this.timer.unref?.();
    return this.timer;
  }

  cancelScheduled(): void {
    if (!this.timer) return;
    this.clock.clearTimeout(this.timer);
    this.timer = undefined;
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
