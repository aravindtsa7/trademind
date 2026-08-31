import { CalendarSessionWindowsByDate, SessionWindow } from '../domain/exchange-calendar.types';
import NiftyUnderlyingIngestionPlannerService, { CLOSED_DISPOSITIONS, NiftyIngestionPlan, NiftyPlannedDateDisposition } from './nifty-underlying-ingestion-planner.service';

/**
 * Thrown BEFORE any manifest generation work (task invariant E) when the
 * requested range contains one or more calendar-UNCERTIFIED dates. Whole-range
 * fail-closed, mirroring `NiftyAcquisitionCalendarBlockedError`'s contract:
 * never a partial per-date skip, never a manifest artifact write, never a
 * provider call, never a persistence mutation.
 */
export class ManifestCalendarBlockedError extends Error {
  readonly blockedDates: readonly string[];

  constructor(plan: NiftyIngestionPlan) {
    const blockedDates = plan.dates.filter((date) => date.disposition === NiftyPlannedDateDisposition.BLOCKED_UNCERTIFIED).map((date) => date.tradingDate);
    const preview = blockedDates.slice(0, 5).join(', ');
    const suffix = blockedDates.length > 5 ? ', ...' : '';
    super(
      `B-F5 dataset manifest generation fails closed: requested range ${plan.requestedFromDate}..${plan.requestedToDate} contains ` +
        `${blockedDates.length} calendar-UNCERTIFIED date(s) (${preview}${suffix}); no manifest artifact is generated, no provider is ` +
        'called, and nothing is persisted.'
    );
    this.name = 'ManifestCalendarBlockedError';
    this.blockedDates = blockedDates;
  }
}

export interface ManifestRequestedSessionsRequest {
  /** Required, YYYY-MM-DD. Never implicitly defaulted. */
  readonly fromDate: string;
  /** Required, YYYY-MM-DD. */
  readonly toDate: string;
}

export interface ManifestRequestedSessions {
  /** Ascending, deduplicated `YYYY-MM-DD` dates that are genuinely REQUESTED trading sessions for this range (task invariant A): REGULAR_SESSION and SPECIAL_SESSION only -- never a certified holiday/exceptional closure/ordinary weekend (task invariant D). */
  readonly tradingDates: readonly string[];
  /** Calendar-declared session windows for every date in `tradingDates`, suitable for `DatasetManifestService`'s/`GrowwOptionCandleAcquisitionService`'s `calendarSessionWindows` request field (task invariant C). */
  readonly calendarSessionWindows: CalendarSessionWindowsByDate;
}

/**
 * Thrown by `resolveSessionWindowsForDates` (never by `resolveRequestedSessions`,
 * which has its own `ManifestCalendarBlockedError`) when a caller-supplied
 * date -- already believed to be a genuine, certified trading session (e.g.
 * a year-runner's own `healthyTradingDates`, produced by calendar-aware
 * acquisition) -- no longer resolves that way against the certified
 * calendar. This is a fail-closed consistency guard (task invariant A: "do
 * not produce a clean year checkpoint/manifest from uncertified scope"), not
 * the normal request-time UNCERTIFIED path: it should be structurally
 * unreachable in practice, since a date only ever reaches this method after
 * a calendar-aware acquisition already required it to be a real trading
 * session -- but if calendar certification changed between acquisition and
 * materialization, this fails the caller closed rather than silently
 * generating a manifest with wrong health.
 */
export class ManifestCalendarSessionWindowLookupError extends Error {
  readonly uncertifiedDates: readonly string[];
  readonly unexpectedlyClosedDates: readonly string[];

  constructor(uncertifiedDates: readonly string[], unexpectedlyClosedDates: readonly string[]) {
    super(
      `ManifestCalendarSessionResolverService.resolveSessionWindowsForDates: one or more caller-supplied dates no longer resolve as a certified trading session -- ` +
        `${uncertifiedDates.length} now UNCERTIFIED (${uncertifiedDates.slice(0, 5).join(', ')}${uncertifiedDates.length > 5 ? ', ...' : ''}), ` +
        `${unexpectedlyClosedDates.length} now resolve CLOSED (${unexpectedlyClosedDates.slice(0, 5).join(', ')}${unexpectedlyClosedDates.length > 5 ? ', ...' : ''}); ` +
        'fails closed rather than generating a manifest against stale/incorrect calendar truth.'
    );
    this.name = 'ManifestCalendarSessionWindowLookupError';
    this.uncertifiedDates = uncertifiedDates;
    this.unexpectedlyClosedDates = unexpectedlyClosedDates;
  }
}

export interface ManifestCalendarSessionResolverServiceDependencies {
  readonly plannerService?: NiftyUnderlyingIngestionPlannerService;
}

/**
 * B-F5 CALENDAR FIX: the single authoritative source B-F5 manifest
 * generation consults -- for BOTH `UNDERLYING_1M` and `EXPIRED_OPTION_1M`
 * (task invariant B) -- to decide which dates are genuinely requested
 * trading sessions and what session windows govern each one's
 * expected-minute health check (task invariant A/C).
 *
 * Reuses the SAME certified NSE/EQUITY calendar plan
 * `NiftyUnderlyingAcquisitionService` already trusts for real acquisition
 * (task: "reuse existing calendar core/resolver/planner truth... do not
 * create a second competing calendar implementation") -- never Monday-Friday
 * arithmetic. There is no certified `EQUITY_DERIVATIVES` calendar coverage
 * in this system (options trade only when the underlying `EQUITY` segment is
 * open -- see `NIFTY_UNDERLYING_CALENDAR_SEGMENT`'s own doc), so reusing the
 * `EQUITY` plan for option manifests is the correct authoritative choice,
 * not a provider-specific shortcut (task: "calendar session selection is an
 * exchange/session concern, not a provider-specific shortcut").
 *
 * Fails closed (`ManifestCalendarBlockedError`) BEFORE returning anything if
 * any requested date is calendar-UNCERTIFIED (task invariant E). A closed
 * date (holiday/exceptional closure/weekend) is simply absent from the
 * result, never reported as a requested session at all (task invariant D).
 *
 * Also the single authoritative source `ResearchYearRunnerService` consults
 * (via `resolveSessionWindowsForDates`) to recover the calendar session
 * windows for a set of ALREADY-DETERMINED trading dates -- e.g. a year
 * run's `healthyTradingDates`, whose disposition/window information was not
 * carried forward through the B-F2/B-F4 acquisition result shape (task
 * invariant A: "repair the typed orchestration boundary appropriately").
 */
export default class ManifestCalendarSessionResolverService {
  private readonly plannerService: NiftyUnderlyingIngestionPlannerService;

  constructor(dependencies: ManifestCalendarSessionResolverServiceDependencies = {}) {
    this.plannerService = dependencies.plannerService ?? new NiftyUnderlyingIngestionPlannerService();
  }

  async resolveRequestedSessions(request: ManifestRequestedSessionsRequest): Promise<ManifestRequestedSessions> {
    const plan = await this.plannerService.buildPlan({ fromDate: request.fromDate, toDate: request.toDate });
    if (plan.hasBlockedDates) throw new ManifestCalendarBlockedError(plan);

    const requestedDates = plan.dates.filter((date) => !CLOSED_DISPOSITIONS.has(date.disposition));
    const tradingDates = requestedDates.map((date) => date.tradingDate);
    const calendarSessionWindows: Record<string, readonly SessionWindow[]> = {};
    for (const date of requestedDates) calendarSessionWindows[date.tradingDate] = date.sessionWindows;

    return { tradingDates, calendarSessionWindows };
  }

  /**
   * Looks up the certified calendar session windows for a caller-supplied
   * set of dates that are ALREADY BELIEVED to be genuine trading sessions
   * (task invariant A) -- e.g. `ResearchYearRunnerService`'s own
   * `healthyTradingDates`, produced by calendar-aware acquisition that
   * already required calendar certification before persisting anything.
   * Unlike `resolveRequestedSessions`, this does NOT filter out closed
   * dates -- every date passed in is expected to resolve as a genuine
   * REGULAR_SESSION or SPECIAL_SESSION; any date that instead resolves
   * UNCERTIFIED or CLOSED throws `ManifestCalendarSessionWindowLookupError`
   * (fail-closed consistency guard) rather than silently generating a
   * manifest with the wrong (or the legacy fixed-375) expected-minute
   * contract. `{}` for an empty `dates` input (never a network/DB call for
   * nothing to resolve).
   */
  async resolveSessionWindowsForDates(dates: readonly string[]): Promise<CalendarSessionWindowsByDate> {
    if (dates.length === 0) return {};

    const sortedUniqueDates = [...new Set(dates)].sort();
    const plan = await this.plannerService.buildPlan({ fromDate: sortedUniqueDates[0], toDate: sortedUniqueDates[sortedUniqueDates.length - 1] });
    const plannedByDate = new Map(plan.dates.map((planned) => [planned.tradingDate, planned]));

    const uncertifiedDates: string[] = [];
    const unexpectedlyClosedDates: string[] = [];
    const calendarSessionWindows: Record<string, readonly SessionWindow[]> = {};

    for (const date of sortedUniqueDates) {
      // `buildPlan({fromDate, toDate})` always returns one entry per calendar
      // date in that inclusive range (`NiftyUnderlyingIngestionPlannerService`
      // contract), and every date in `sortedUniqueDates` lies within
      // [sortedUniqueDates[0], sortedUniqueDates[last]] by construction --
      // this lookup cannot miss.
      const planned = plannedByDate.get(date);
      if (!planned || planned.disposition === NiftyPlannedDateDisposition.BLOCKED_UNCERTIFIED) {
        uncertifiedDates.push(date);
        continue;
      }
      if (CLOSED_DISPOSITIONS.has(planned.disposition)) {
        unexpectedlyClosedDates.push(date);
        continue;
      }
      calendarSessionWindows[date] = planned.sessionWindows;
    }

    if (uncertifiedDates.length > 0 || unexpectedlyClosedDates.length > 0) {
      throw new ManifestCalendarSessionWindowLookupError(uncertifiedDates, unexpectedlyClosedDates);
    }

    return calendarSessionWindows;
  }
}
