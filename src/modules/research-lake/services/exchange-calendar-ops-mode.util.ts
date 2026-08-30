export enum ExchangeCalendarOpsMode {
  VALIDATE = 'VALIDATE',
  IMPORT_DRAFT = 'IMPORT_DRAFT',
  CERTIFY = 'CERTIFY',
  VERIFY = 'VERIFY',
}

export class ExchangeCalendarOpsModeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExchangeCalendarOpsModeError';
  }
}

/**
 * B-F7A-FIXTURES-1 operator-runner mode parser. `undefined`/blank input is
 * the ONLY input that defaults to `VALIDATE` (the safe default, task
 * section 24). Any OTHER unrecognized string -- including a near-miss typo
 * of a real mode name -- is REJECTED rather than silently defaulted to
 * `VALIDATE` or silently coerced to the closest real mode: task section 25
 * explicitly requires that "mutation must not occur merely because a mode
 * argument was typoed/defaulted," which cuts both ways -- a typo must
 * never silently become a no-op mutation attempt via the wrong mode NOR
 * silently become `VALIDATE`, since either would hide the operator's
 * mistake from them instead of failing loudly.
 */
export function parseExchangeCalendarOpsMode(raw: string | undefined): ExchangeCalendarOpsMode {
  const trimmed = raw?.trim();
  if (!trimmed) return ExchangeCalendarOpsMode.VALIDATE;
  if (Object.values(ExchangeCalendarOpsMode).includes(trimmed as ExchangeCalendarOpsMode)) {
    return trimmed as ExchangeCalendarOpsMode;
  }
  throw new ExchangeCalendarOpsModeError(
    `Unrecognized RESEARCH_CALENDAR_MODE '${raw}'. Expected one of: ${Object.values(ExchangeCalendarOpsMode).join(', ')} (or unset, which defaults to VALIDATE).`
  );
}
