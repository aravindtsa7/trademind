import { computeCoverageSourceBundleChecksum } from '../domain/exchange-calendar-checksum';
import { ExchangeCalendarCoverageFixture, validateAndNormalizeCoverageFixture } from '../domain/exchange-calendar-fixture.types';
import ExchangeCalendarRepository, { ExchangeCalendarImportOutcome } from '../repositories/exchange-calendar.repository';

/**
 * B-F7A CORE importer/normalizer (task section 10). Splits cleanly into two
 * phases:
 *   1. validation/normalization/checksum computation -- pure, synchronous,
 *      zero I/O (`validateAndNormalizeCoverageFixture` /
 *      `computeCoverageSourceBundleChecksum`); every structural rejection
 *      (task section 10/13.I/J/K/L/M/N/S) happens here, BEFORE any
 *      repository call (task section 13.Y).
 *   2. atomic persistence -- delegated entirely to
 *      `ExchangeCalendarRepository.importCoverage`, which owns DRAFT-only
 *      status enforcement, idempotency, version-conflict rejection, and
 *      defensive revalidation inside one DB transaction. Certification is a
 *      separate operation in `ExchangeCalendarCertificationService`.
 *
 * This service never calls a provider/network endpoint and never mutates a
 * previously-persisted coverage row's content (task section 9/10).
 */
export default class ExchangeCalendarImporterService {
  private readonly repository: ExchangeCalendarRepository;

  constructor(repository: ExchangeCalendarRepository = new ExchangeCalendarRepository()) {
    this.repository = repository;
  }

  async importCoverage(fixture: ExchangeCalendarCoverageFixture): Promise<ExchangeCalendarImportOutcome> {
    const normalized = validateAndNormalizeCoverageFixture(fixture);
    const sourceBundleChecksum = computeCoverageSourceBundleChecksum(normalized);
    return this.repository.importCoverage(normalized, fixture.status, sourceBundleChecksum);
  }
}
