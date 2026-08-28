/** Parsed, host-timezone-independent Gregorian calendar date. */
export interface ExchangeCalendarDateParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

export class ExchangeCalendarDateInvariantError extends Error {
  constructor(label: string, value: string) {
    super(`${label} '${value}' is not a valid YYYY-MM-DD Gregorian calendar date.`);
    this.name = 'ExchangeCalendarDateInvariantError';
  }
}

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/** Strictly parses YYYY-MM-DD without Date.parse rollover behavior. */
export function parseExchangeCalendarDate(value: string, label = 'date'): ExchangeCalendarDateParts {
  const match = DATE_PATTERN.exec(value);
  if (!match) throw new ExchangeCalendarDateInvariantError(label, value);

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    throw new ExchangeCalendarDateInvariantError(label, value);
  }
  return { year, month, day };
}

export function exchangeCalendarYear(value: string, label = 'date'): number {
  return parseExchangeCalendarDate(value, label).year;
}

export function exchangeCalendarDateToUtc(value: string, label = 'date'): Date {
  const { year, month, day } = parseExchangeCalendarDate(value, label);
  const result = new Date(0);
  result.setUTCHours(0, 0, 0, 0);
  result.setUTCFullYear(year, month - 1, day);
  return result;
}

export function addExchangeCalendarDays(value: string, days: number): string {
  if (!Number.isInteger(days)) throw new Error(`days must be an integer, got ${days}.`);
  const result = exchangeCalendarDateToUtc(value);
  result.setUTCDate(result.getUTCDate() + days);
  return result.toISOString().slice(0, 10);
}
