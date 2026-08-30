import { ExchangeCalendarOpsMode } from './exchange-calendar-ops-mode.util';

export class ExchangeCalendarOpsMutationRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExchangeCalendarOpsMutationRefusedError';
  }
}

const MUTATING_MODES: ReadonlySet<ExchangeCalendarOpsMode> = new Set([ExchangeCalendarOpsMode.IMPORT_DRAFT, ExchangeCalendarOpsMode.CERTIFY]);

/**
 * B-F7A-FIXTURES-1 mutation opt-in gate (task section 25). `VALIDATE`/
 * `VERIFY` never require opt-in -- they are read-only/pure by construction
 * regardless of this flag. `IMPORT_DRAFT`/`CERTIFY` require the exact
 * string `'true'` in `applyFlag`; anything else (undefined, empty, '1',
 * 'TRUE', 'yes', a typo) is refused. This function throws BEFORE the
 * caller constructs any importer/certifier request -- it has no
 * dependency on the fixture registry, the database, or either mutating
 * service, so it can never be bypassed by an error in a later step.
 */
export function assertMutationApplyOptIn(mode: ExchangeCalendarOpsMode, applyFlag: string | undefined): void {
  if (!MUTATING_MODES.has(mode)) return;
  if (applyFlag === 'true') return;
  throw new ExchangeCalendarOpsMutationRefusedError(
    `RESEARCH_CALENDAR_MODE=${mode} is a mutating mode and requires RESEARCH_CALENDAR_APPLY=true (exact match) as an explicit, separate opt-in. ` +
      `Refusing to proceed -- a missing, blank, or near-miss value never implies consent.`
  );
}

/** `URL#hostname` keeps the brackets for an IPv6 literal (`new URL('mysql://x@[::1]:3306/y').hostname === '[::1]'`) -- verified directly, not assumed. */
const LOCAL_DATABASE_HOSTNAME_ALLOWLIST: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);

export class ExchangeCalendarOpsTargetRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExchangeCalendarOpsTargetRefusedError';
  }
}

/**
 * B-F7A-FIXTURES-1 local-development-database guard (task section 27).
 * FAIL-CLOSED ALLOWLIST, not a denylist of "production-looking" names: a
 * database URL is accepted for mutation ONLY when its hostname is exactly
 * `localhost`, `127.0.0.1`, or `::1`. Every other hostname -- a real
 * remote host, an unrecognized/unparseable URL, or a missing URL -- is
 * refused. Deliberately has no override/escape hatch (task section 27:
 * "Do not create a production-override escape hatch casually in this
 * slice").
 *
 * Never includes the raw `databaseUrl` (which may carry a username/
 * password) in a thrown error message -- only the parsed, already-public
 * hostname (or the literal string 'unparseable'/'missing') is ever
 * surfaced.
 */
export function assertLocalDevDatabaseTarget(databaseUrl: string | undefined): void {
  if (!databaseUrl) {
    throw new ExchangeCalendarOpsTargetRefusedError('Refusing to mutate: no DATABASE_URL is configured (target is missing, not confidently local).');
  }
  let hostname: string;
  try {
    hostname = new URL(databaseUrl).hostname;
  } catch {
    throw new ExchangeCalendarOpsTargetRefusedError('Refusing to mutate: DATABASE_URL could not be parsed as a URL (target is unparseable, not confidently local).');
  }
  if (!LOCAL_DATABASE_HOSTNAME_ALLOWLIST.has(hostname)) {
    throw new ExchangeCalendarOpsTargetRefusedError(
      `Refusing to mutate: database host '${hostname}' is not on the local-development allowlist (${[...LOCAL_DATABASE_HOSTNAME_ALLOWLIST].join(', ')}). ` +
        'This guard has no override -- point RESEARCH_CALENDAR_MODE at a local database or do not run a mutating mode.'
    );
  }
}
