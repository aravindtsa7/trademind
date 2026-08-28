import { istCalendarDate } from '../domain/ist-session-clock';
import { GrowwSymbolKind, parseGrowwSymbol } from '../providers/groww/groww-contract-symbol-parser';
import {
  computeResearchYearRunPlanSemanticIdentity,
  deterministicWeekdayTradingDates,
  RequiredOptionSession,
  RequiredOptionSessionSource,
  RESEARCH_YEAR_RUN_SCHEMA_VERSION,
  RESEARCH_YEAR_RUN_SEMANTICS_VERSION,
  RESEARCH_YEAR_RUN_STAGE_ORDER,
  ResearchYearRunPlan,
  ResearchYearRunPlanBlockedCode,
  ResearchYearRunPlanStage,
  ResearchYearRunRequest,
  ResearchYearRunScope,
  ResearchYearRunStageKind,
  ResolvedResearchYearRunRange,
  sortRequiredOptionSessions,
} from '../domain/research-year-run.types';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The ONLY `RequiredOptionSessionSource` B-F8 ships with. Fails closed with
 * a descriptive, typed error rather than ever inventing an ATM/moneyness/
 * expiry-selection rule itself (task section 7) -- see the B-F8 final
 * report's "strategy-universe contract selection path" section for why no
 * existing, reusable, provider-agnostic implementation of this source
 * exists in the repository today.
 */
export class UnavailableRequiredOptionSessionSource implements RequiredOptionSessionSource {
  async resolve(): Promise<readonly RequiredOptionSession[]> {
    throw new Error(
      'B-F8 STRATEGY-UNIVERSE BLOCKER: no RequiredOptionSessionSource is configured. The existing per-signal ATM contract selector ' +
        '(OptionContractSelectorService, src/modules/options/services/option-contract-selector.service.ts) requires a live spot price ' +
        'at each strategy signal timestamp and operates against the legacy Upstox-backed options module (HistoricalOptionCandleRepository), ' +
        'not the research-lake Groww-backed catalog (HistoricalOptionContractCatalogRepository/providerContractId identity) B-F3/B-F4 built. ' +
        'There is no existing, deterministic, batch, provider-agnostic API in this repository that enumerates "the required NIFTY option ' +
        'contracts + trading dates for the frozen V2/V4/V8 strategy universe over an arbitrary date range" without re-running each ' +
        'strategy\'s full signal-generation research pipeline against the legacy options stack. B-F8 will not invent that selection logic ' +
        '(no new ATM rule, moneyness band, or expiry preference) -- inject a RequiredOptionSessionSource that wraps a real, already-' +
        'authoritative implementation once one exists.'
    );
  }
}

export interface ResearchYearPlanServiceDependencies {
  readonly now?: () => Date;
  readonly requiredOptionSessionSource?: RequiredOptionSessionSource;
}

/**
 * B-F8 deterministic year-plan builder. Pure with respect to acquisition/
 * storage: never calls a provider, never touches the repository/filesystem
 * itself. The only I/O this service ever performs is delegating to the
 * caller-injected `RequiredOptionSessionSource` (task section 7/16) -- which
 * defaults to `UnavailableRequiredOptionSessionSource` (zero I/O, always
 * throws) so a plan can always be built, with the OPTIONS-dependent stages
 * simply reported `blocked: true` rather than the whole plan construction
 * failing.
 */
export default class ResearchYearPlanService {
  private readonly now: () => Date;
  private readonly requiredOptionSessionSource: RequiredOptionSessionSource;

  constructor(dependencies: ResearchYearPlanServiceDependencies = {}) {
    this.now = dependencies.now ?? (() => new Date());
    this.requiredOptionSessionSource = dependencies.requiredOptionSessionSource ?? new UnavailableRequiredOptionSessionSource();
  }

  /**
   * Resolves and validates the requested year/date range (task section 3).
   * A past year may default to the full calendar year; the current calendar
   * year (by IST calendar date, via the injectable clock) always requires an
   * explicit `toDate` -- never silently defaulted to "today" -- and that
   * `toDate` must be STRICTLY EARLIER than today's IST calendar date (task
   * correction section 1). Upstox's documented 1-minute historical
   * availability for a given trading day is only reliably usable starting
   * the NEXT MORNING, never at same-day EOD -- so `toDate === todayIst` is
   * rejected exactly like `toDate > todayIst`; only `toDate <= yesterday`
   * is ever accepted. This is a fixed calendar-date comparison only -- it
   * never subtracts weekends/holidays to compute "yesterday's trading day".
   */
  resolveRange(request: ResearchYearRunRequest): ResolvedResearchYearRunRange {
    if (!Number.isInteger(request.year) || request.year < 2000) {
      throw new Error(`ResearchYearPlanService requires an integer year >= 2000; received '${String(request.year)}'.`);
    }
    if (request.fromDate !== undefined) this.assertValidDate('fromDate', request.fromDate);
    if (request.toDate !== undefined) this.assertValidDate('toDate', request.toDate);
    if (request.fromDate !== undefined && request.toDate !== undefined && request.fromDate > request.toDate) {
      throw new Error(`ResearchYearPlanService requires fromDate (${request.fromDate}) <= toDate (${request.toDate}).`);
    }
    if (request.fromDate !== undefined && Number(request.fromDate.slice(0, 4)) !== request.year) {
      throw new Error(`ResearchYearPlanService requires fromDate (${request.fromDate}) to belong to the requested year (${request.year}) -- never silently crossing calendar years.`);
    }
    if (request.toDate !== undefined && Number(request.toDate.slice(0, 4)) !== request.year) {
      throw new Error(`ResearchYearPlanService requires toDate (${request.toDate}) to belong to the requested year (${request.year}) -- never silently crossing calendar years.`);
    }

    const todayIst = istCalendarDate(this.now());
    const currentYear = Number(todayIst.slice(0, 4));

    if (request.year > currentYear) {
      throw new Error(`ResearchYearPlanService rejects a future year (${request.year}); the current IST calendar year is ${currentYear} and no historical data can exist yet for a year that has not started.`);
    }

    if (request.year === currentYear) {
      if (request.toDate === undefined) {
        throw new Error(
          `ResearchYearPlanService requires an explicit toDate for the current calendar year (${currentYear}) -- it never silently defaults toDate to "today". ` +
            'Upstox prior-day full 1m historical availability is reliably usable only the NEXT MORNING, not immediately at same-day EOD; the current trading day is never automatically certified as a complete historical session.'
        );
      }
      if (request.toDate >= todayIst) {
        throw new Error(
          `ResearchYearPlanService rejects toDate (${request.toDate}) for the current calendar year: today's IST calendar date (${todayIst}) is intentionally excluded because prior-day historical ` +
            'availability is the safe boundary -- Upstox 1m historical data for a given trading day is reliably usable only from the NEXT MORNING, never at same-day EOD. ' +
            'Supply a toDate strictly earlier than today (e.g. yesterday\'s calendar date).'
        );
      }
      const fromDate = request.fromDate ?? `${request.year}-01-01`;
      return { year: request.year, fromDate, toDate: request.toDate };
    }

    // Past year: safe to default the full calendar year when no explicit range was supplied.
    const fromDate = request.fromDate ?? `${request.year}-01-01`;
    const toDate = request.toDate ?? `${request.year}-12-31`;
    return { year: request.year, fromDate, toDate };
  }

  /**
   * Builds the deterministic B-F8 year plan. Stable for identical inputs
   * (task section 9.F): stage order is a fixed constant, trading dates are
   * derived purely from the resolved range, and required option sessions
   * (when a `RequiredOptionSessionSource` is configured) are re-sorted
   * deterministically regardless of source order (task section 9.J). Never
   * influenced by wall-clock time beyond the injectable `now()` used for
   * current-year resolution -- `planSemanticIdentity` never includes a
   * timestamp.
   */
  async buildPlan(request: ResearchYearRunRequest): Promise<ResearchYearRunPlan> {
    const range = this.resolveRange(request);
    const underlyingInScope = request.scope === ResearchYearRunScope.UNDERLYING || request.scope === ResearchYearRunScope.ALL;
    const optionsInScope = request.scope === ResearchYearRunScope.OPTIONS || request.scope === ResearchYearRunScope.ALL;
    const underlyingCandidateDates = deterministicWeekdayTradingDates(range.fromDate, range.toDate);

    let requiredOptionSessions: readonly RequiredOptionSession[] | null = null;
    let optionsBlocked = false;
    let optionsBlockedCode: ResearchYearRunPlanBlockedCode | null = null;
    let optionsBlockedReason: string | null = null;
    if (optionsInScope) {
      try {
        const resolved = await this.requiredOptionSessionSource.resolve(range);
        requiredOptionSessions = this.normalizeRequiredOptionSessions(resolved);
      } catch (error) {
        optionsBlocked = true;
        optionsBlockedCode = ResearchYearRunPlanBlockedCode.REQUIRED_OPTION_SESSION_SOURCE_UNAVAILABLE;
        // Free-text diagnostic ONLY -- never part of planSemanticIdentity (task correction section 2). May legitimately
        // vary run-to-run (timestamps, OS paths, provider detail) for the exact same stable `optionsBlockedCode`.
        optionsBlockedReason = error instanceof Error ? error.message : String(error);
      }
    }

    const stages: ResearchYearRunPlanStage[] = RESEARCH_YEAR_RUN_STAGE_ORDER.map((stageKind) => {
      switch (stageKind) {
        case ResearchYearRunStageKind.UNDERLYING_ACQUISITION:
        case ResearchYearRunStageKind.UNDERLYING_MATERIALIZATION:
          return {
            stageKind,
            inScope: underlyingInScope,
            underlyingCandidateDates: underlyingInScope ? underlyingCandidateDates : null,
            requiredOptionSessions: null,
            blocked: false,
            blockedCode: null,
            blockedReason: null,
          };
        case ResearchYearRunStageKind.OPTION_CATALOG_ACQUISITION:
          // Full point-in-time catalog discovery never depends on the strategy universe (task section 6) -- never blocked.
          return { stageKind, inScope: optionsInScope, underlyingCandidateDates: null, requiredOptionSessions: null, blocked: false, blockedCode: null, blockedReason: null };
        case ResearchYearRunStageKind.OPTION_CANDLE_ACQUISITION:
        case ResearchYearRunStageKind.OPTION_MATERIALIZATION:
          return {
            stageKind,
            inScope: optionsInScope,
            underlyingCandidateDates: null,
            requiredOptionSessions: optionsInScope ? requiredOptionSessions : null,
            blocked: optionsInScope && optionsBlocked,
            blockedCode: optionsInScope ? optionsBlockedCode : null,
            blockedReason: optionsInScope ? optionsBlockedReason : null,
          };
        default: {
          const exhaustive: never = stageKind;
          throw new Error(`Unhandled ResearchYearRunStageKind: ${String(exhaustive)}`);
        }
      }
    });

    const planSemanticIdentity = computeResearchYearRunPlanSemanticIdentity({
      schemaVersion: RESEARCH_YEAR_RUN_SCHEMA_VERSION,
      semanticsVersion: RESEARCH_YEAR_RUN_SEMANTICS_VERSION,
      year: range.year,
      fromDate: range.fromDate,
      toDate: range.toDate,
      scope: request.scope,
      // Deliberately maps away `blockedReason` (free-text diagnostic, never identity material -- task correction section 2).
      stages: stages.map((stage) => ({
        stageKind: stage.stageKind,
        inScope: stage.inScope,
        underlyingCandidateDates: stage.underlyingCandidateDates,
        requiredOptionSessions: stage.requiredOptionSessions,
        blocked: stage.blocked,
        blockedCode: stage.blockedCode,
      })),
    });

    return {
      schemaVersion: RESEARCH_YEAR_RUN_SCHEMA_VERSION,
      semanticsVersion: RESEARCH_YEAR_RUN_SEMANTICS_VERSION,
      year: range.year,
      fromDate: range.fromDate,
      toDate: range.toDate,
      scope: request.scope,
      planSemanticIdentity,
      stages,
    };
  }

  /** Deduplicates/sorts trading dates within each session and sorts sessions by parsed contract identity -- never by raw source order (task section 9.J). Fails closed on a malformed providerContractId or duplicate contract, mirroring `NiftyHistoricalContractCatalogAcquisitionService`'s own strictness. */
  private normalizeRequiredOptionSessions(sessions: readonly RequiredOptionSession[]): RequiredOptionSession[] {
    const seen = new Set<string>();
    const normalized: RequiredOptionSession[] = [];
    for (const session of sessions) {
      if (seen.has(session.providerContractId)) {
        throw new Error(`RequiredOptionSessionSource returned duplicate providerContractId '${session.providerContractId}'.`);
      }
      seen.add(session.providerContractId);
      if (session.tradingDates.length === 0) {
        throw new Error(`RequiredOptionSessionSource returned providerContractId '${session.providerContractId}' with zero tradingDates.`);
      }
      for (const date of session.tradingDates) this.assertValidDate('tradingDate', date);
      normalized.push({ providerContractId: session.providerContractId, tradingDates: [...new Set(session.tradingDates)].sort() });
      this.parseIdentityOrThrow(session.providerContractId);
    }
    return sortRequiredOptionSessions(normalized, (id) => this.parseIdentityOrThrow(id));
  }

  private parseIdentityOrThrow(providerContractId: string): { expiry: Date; strikePrice: number; optionType: string } {
    const parsed = parseGrowwSymbol(providerContractId, { exchange: 'NSE', underlyingSymbol: 'NIFTY' });
    if (!parsed.ok || parsed.value.kind !== GrowwSymbolKind.OPTION) {
      throw new Error(`RequiredOptionSessionSource returned providerContractId '${providerContractId}' that could not be parsed as an NSE NIFTY option symbol.`);
    }
    return { expiry: parsed.value.expiry, strikePrice: parsed.value.strikePrice, optionType: parsed.value.optionType };
  }

  private assertValidDate(field: string, value: string): void {
    if (!DATE_PATTERN.test(value) || Number.isNaN(new Date(`${value}T00:00:00Z`).getTime())) {
      throw new Error(`ResearchYearPlanService requires ${field} to be a valid YYYY-MM-DD date; received '${value}'.`);
    }
  }
}
