import { Exchange, ExchangeSegment } from '../domain/exchange-calendar.types';
import ExchangeCalendarRepository, {
  ExchangeCalendarActivationOutcome,
} from '../repositories/exchange-calendar.repository';

export interface ActivateExchangeCalendarVersionRequest {
  readonly exchange: Exchange;
  readonly segment: ExchangeSegment;
  readonly calendarYear: number;
  readonly version: number;
}

/** Sole application service for making an imported DRAFT authoritative. */
export default class ExchangeCalendarCertificationService {
  constructor(private readonly repository: ExchangeCalendarRepository = new ExchangeCalendarRepository()) {}

  async activateCertifiedVersion(request: ActivateExchangeCalendarVersionRequest): Promise<ExchangeCalendarActivationOutcome> {
    return this.repository.activateCertifiedVersion(request);
  }
}
