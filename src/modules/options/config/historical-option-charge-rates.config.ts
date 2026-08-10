import {
  HistoricalOptionBrokerageConfiguration,
  HistoricalOptionStatutoryChargesRateConfiguration,
} from '../dto/historical-option-charges.dto';

const marketDateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Kolkata',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/**
 * Research coverage begins on 2026-03-01 because NSE revised its equity-options
 * transaction-charge/IPFT split on that date. The combined published charge is
 * 3,553 rupees per crore of option premium, represented as 0.03553%.
 * Source: NSE circular NSE/FA/73061, dated 2026-02-27.
 * https://nsearchives.nseindia.com/content/circulars/FA73061.pdf
 */
const preApril2026StatutoryRates: HistoricalOptionStatutoryChargesRateConfiguration = {
  id: 'nse-equity-options-2026-03-01-to-2026-03-31',
  effectiveFrom: '2026-03-01',
  effectiveTo: '2026-03-31',

  // 0.10% STT on sell-side option premium through 2026-03-31.
  // Source: NSE Securities Transaction Tax schedule, Finance Act 2026 comparison table.
  // https://www.nseindia.com/static/products-services/equity-derivatives-securities-transaction-tax
  stt: { side: 'SELL', rate: { value: 0.1, unit: 'PERCENT' } },

  // 3,553 rupees per crore of option premium, including the 0.01/crore NSE IPFT component.
  // Source: NSE circular NSE/FA/73061; Upstox transaction-charge table.
  exchangeTransactionChargeRate: { value: 0.03553, unit: 'PERCENT' },

  // 10 rupees per crore of equity-options premium turnover.
  // Source: SEBI fee schedule / Upstox statutory charges table.
  sebiTurnoverRate: { value: 10, unit: 'PER_CRORE' },

  // 18% GST on brokerage plus transaction/IPFT charges. IPFT is included in exchange charges.
  // Source: Upstox Equity Options statutory charges table.
  gst: {
    rate: { value: 18, unit: 'PERCENT' },
    taxableComponents: ['BROKERAGE', 'EXCHANGE_TRANSACTION_CHARGES'],
  },

  // 0.003% (300 rupees/crore) stamp duty on buy-side option-premium turnover.
  // Source: Upstox Equity Options statutory charges table; stamp-duty FAQ.
  stampDuty: { side: 'BUY', rate: { value: 0.003, unit: 'PERCENT' } },
};

const postApril2026StatutoryRates: HistoricalOptionStatutoryChargesRateConfiguration = {
  ...preApril2026StatutoryRates,
  id: 'nse-equity-options-from-2026-04-01',
  effectiveFrom: '2026-04-01',
  effectiveTo: undefined,

  // 0.15% STT on sell-side option premium from 2026-04-01.
  // Source: NSE Securities Transaction Tax schedule, Finance Act 2026 comparison table.
  // https://www.nseindia.com/static/products-services/equity-derivatives-securities-transaction-tax
  stt: { side: 'SELL', rate: { value: 0.15, unit: 'PERCENT' } },
};

const statutoryConfigurations: readonly HistoricalOptionStatutoryChargesRateConfiguration[] = [
  preApril2026StatutoryRates,
  postApril2026StatutoryRates,
];

/**
 * Broker-plan examples, not statutory charges. Historical research must select
 * one explicitly; the currently observed account plan cannot infer old trades.
 * Standard tariff source: https://upstox.com/brokerage-charges/?hl=en_IN
 */
export const HISTORICAL_OPTION_BROKERAGE_CONFIGURATIONS = deepFreeze({
  STANDARD: {
    id: 'upstox-standard-options-20-per-executed-order',
    effectiveFrom: '2026-03-01',
    brokeragePerExecutedOrder: 20,
    numberOfOrders: 2,
  } satisfies HistoricalOptionBrokerageConfiguration,
  PLUS: {
    id: 'upstox-plus-options-30-per-executed-order',
    effectiveFrom: '2026-03-01',
    brokeragePerExecutedOrder: 30,
    numberOfOrders: 2,
  } satisfies HistoricalOptionBrokerageConfiguration,
});

/**
 * Selects the statutory/exchange schedule using the trade's Indian market date.
 * Dates before 2026-03-01 are intentionally unsupported: the module does not
 * infer earlier NSE/IPFT structures.
 */
export function getHistoricalOptionChargeRateConfig(
  tradeDate: Date
): HistoricalOptionStatutoryChargesRateConfiguration {
  if (!(tradeDate instanceof Date) || Number.isNaN(tradeDate.getTime())) {
    throw new Error('Historical option charge-rate selection requires a valid trade date.');
  }

  const marketDate = getMarketDate(tradeDate);
  const configuration = statutoryConfigurations.find(
    (candidate) =>
      marketDate >= candidate.effectiveFrom &&
      (candidate.effectiveTo === undefined || marketDate <= candidate.effectiveTo)
  );
  if (!configuration) {
    throw new Error(`No supported historical option charge-rate configuration exists for ${marketDate}.`);
  }

  return deepFreeze(structuredClone(configuration));
}

/** Explicit alias that distinguishes statutory schedules from brokerage plans. */
export const getHistoricalOptionStatutoryChargeRateConfig = getHistoricalOptionChargeRateConfig;

function getMarketDate(date: Date): string {
  const values = Object.fromEntries(
    marketDateFormatter.formatToParts(date).map((part) => [part.type, part.value])
  );
  return `${values.year}-${values.month}-${values.day}`;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach((item) => deepFreeze(item));
  }
  return value;
}
