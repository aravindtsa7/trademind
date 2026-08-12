const formatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});
const sessionEndMinute = 15 * 60 + 30;

export function isAtOrAfterIstSessionEnd(value: Date): boolean {
  const parts = istParts(value);
  return parts.weekday !== 'Sat' && parts.weekday !== 'Sun' && parts.minute >= sessionEndMinute;
}

export function millisecondsUntilIstSessionEnd(value: Date): number {
  const parts = istParts(value);
  const end = new Date(`${parts.date}T15:30:00+05:30`).getTime();
  return Math.max(0, end - value.getTime());
}

/** Idempotent async latch shared by EOD timers, late ticks, and socket events. */
export class IstSessionEodCoordinator {
  private completion: Promise<void> | undefined;

  runOnce(at: Date, action: () => Promise<void> | void): Promise<boolean> {
    if (!isAtOrAfterIstSessionEnd(at)) return Promise.resolve(false);
    if (!this.completion) this.completion = Promise.resolve().then(action);
    return this.completion.then(() => true);
  }

  schedule(action: () => Promise<void> | void, now: () => Date = () => new Date()): NodeJS.Timeout {
    const timer = setTimeout(() => { void this.runOnce(now(), action); }, millisecondsUntilIstSessionEnd(now()));
    timer.unref();
    return timer;
  }
}

function istParts(value: Date): { date: string; weekday: string; minute: number } {
  const parts = Object.fromEntries(formatter.formatToParts(value).map((part) => [part.type, part.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, weekday: parts.weekday, minute: Number(parts.hour) * 60 + Number(parts.minute) };
}
