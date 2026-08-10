import axios from 'axios';
import dotenv from 'dotenv';
import { Instrument } from '@prisma/client';
import logger from '../core/logger/logger';
import InstrumentRepository from '../modules/instruments/repositories/instrument.repository';
import UpstoxOptionChargesClient from '../modules/options/client/upstox-option-charges.client';
import {
  getHistoricalOptionChargeRateConfig,
  HISTORICAL_OPTION_BROKERAGE_CONFIGURATIONS,
} from '../modules/options/config/historical-option-charge-rates.config';
import { OptionTradeCharges } from '../modules/options/dto/option-trade-pnl.dto';
import HistoricalOptionChargesCalculatorService from '../modules/options/services/historical-option-charges-calculator.service';
import OptionRoundTripChargesService from '../modules/options/services/option-round-trip-charges.service';

dotenv.config();

const niftyInstrumentKey = 'NSE_INDEX|Nifty 50';
const optionProduct = 'I';
const componentToleranceRupees = 0.1;
const totalToleranceRupees = 0.25;
const marketDateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Kolkata',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

interface LiveLtpResponse {
  status?: unknown;
  data?: Record<string, { last_price?: unknown }>;
}

const chargeFields: readonly (keyof OptionTradeCharges)[] = [
  'brokerage',
  'stt',
  'exchangeTransactionCharges',
  'sebiCharges',
  'gst',
  'stampDuty',
  'otherCharges',
];

async function fetchLtp(accessToken: string, instrumentKey: string): Promise<number> {
  const url = `https://api.upstox.com/v3/market-quote/ltp?${new URLSearchParams({ instrument_key: instrumentKey }).toString()}`;
  const response = await axios.get<LiveLtpResponse>(url, {
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    timeout: 10_000,
  });
  if (response.data.status !== 'success' || !response.data.data) {
    throw new Error(`Upstox LTP response was not successful for ${instrumentKey}.`);
  }
  const quote = Object.values(response.data.data)[0];
  if (!quote || typeof quote.last_price !== 'number' || !Number.isFinite(quote.last_price) || quote.last_price <= 0) {
    throw new Error(`Upstox LTP response did not contain a positive price for ${instrumentKey}.`);
  }
  return quote.last_price;
}

function getMarketDate(date: Date): string {
  const values = Object.fromEntries(
    marketDateFormatter.formatToParts(date).map((part) => [part.type, part.value])
  );
  return `${values.year}-${values.month}-${values.day}`;
}

function selectNearestAtmCe(
  instruments: readonly Instrument[],
  spotPrice: number,
  tradeDate: string
): Instrument {
  const eligible = instruments.filter((instrument) =>
    instrument.isActive &&
    instrument.instrumentType === 'CE' &&
    getMarketDate(instrument.expiry) >= tradeDate &&
    instrument.lotSize > 0
  );
  if (eligible.length === 0) {
    throw new Error('No active NIFTY CE contracts with a future/current expiry and lot size are available.');
  }
  const nearestExpiry = [...eligible]
    .sort((left, right) => left.expiry.getTime() - right.expiry.getTime())[0].expiry.getTime();
  return eligible
    .filter((instrument) => instrument.expiry.getTime() === nearestExpiry)
    .sort((left, right) => {
      const leftDistance = Math.abs(Number(left.strikePrice) - spotPrice);
      const rightDistance = Math.abs(Number(right.strikePrice) - spotPrice);
      return leftDistance - rightDistance || Number(left.strikePrice) - Number(right.strikePrice);
    })[0];
}

function alignToTick(price: number, tickSize: number): number {
  if (!Number.isFinite(tickSize) || tickSize <= 0) {
    throw new Error('Selected option contract has an invalid tick size.');
  }
  return Math.round(price / tickSize) * tickSize;
}

function money(value: number): string {
  return value.toFixed(4);
}

function printCharges(label: string, charges: OptionTradeCharges, total: number): void {
  console.log(`${label}: brokerage=${money(charges.brokerage)} | stt=${money(charges.stt)} | exchange=${money(charges.exchangeTransactionCharges)} | sebi=${money(charges.sebiCharges)} | gst=${money(charges.gst)} | stampDuty=${money(charges.stampDuty)} | other=${money(charges.otherCharges)} | total=${money(total)}`);
}

function validateDifferences(
  brokerCharges: OptionTradeCharges,
  configuredCharges: OptionTradeCharges,
  brokerTotal: number,
  configuredTotal: number
): void {
  const componentFailures = chargeFields
    .map((field) => ({ field, difference: configuredCharges[field] - brokerCharges[field] }))
    .filter(({ difference }) => Math.abs(difference) > componentToleranceRupees);
  const totalDifference = configuredTotal - brokerTotal;
  const totalPercentageDifference = (totalDifference / brokerTotal) * 100;

  if (componentFailures.length > 0 || Math.abs(totalDifference) > totalToleranceRupees) {
    const detail = componentFailures.map(({ field, difference }) => `${field}=${money(difference)}`).join(', ');
    throw new Error(`Historical charge reconciliation exceeded tolerance: ${detail || 'total'}; totalDifference=${money(totalDifference)}; totalPercentageDifference=${money(totalPercentageDifference)}%.`);
  }
}

async function run(): Promise<void> {
  const accessToken = process.env.UPSTOX_ACCESS_TOKEN?.trim();
  if (!accessToken) throw new Error('Set UPSTOX_ACCESS_TOKEN in .env before running this reconciliation test.');

  const tradeDate = new Date();
  const marketDate = getMarketDate(tradeDate);
  logger.info('Starting historical option charges reconciliation', { marketDate });
  const repository = new InstrumentRepository();
  const [spotPrice, options] = await Promise.all([
    fetchLtp(accessToken, niftyInstrumentKey),
    repository.findByUnderlying('NIFTY'),
  ]);
  const contract = selectNearestAtmCe(options, spotPrice, marketDate);
  const currentPremium = await fetchLtp(accessToken, contract.instrumentKey);
  const tickSize = Number(contract.tickSize);
  const entryPrice = alignToTick(currentPremium, tickSize);
  const exitPrice = alignToTick(entryPrice * 1.1, tickSize);
  if (entryPrice <= 0 || exitPrice <= 0) throw new Error('Could not derive positive deterministic option example prices.');

  const quantity = contract.lotSize;
  const roundTrip = await new OptionRoundTripChargesService(new UpstoxOptionChargesClient(accessToken)).calculate({
    instrumentKey: contract.instrumentKey,
    quantity,
    product: optionProduct,
    entryPrice,
    exitPrice,
  });
  const statutoryRateConfiguration = getHistoricalOptionChargeRateConfig(tradeDate);
  // This reconciliation deliberately chooses a plan; it does not infer historic brokerage.
  const brokerageConfiguration = HISTORICAL_OPTION_BROKERAGE_CONFIGURATIONS.STANDARD;
  const configured = new HistoricalOptionChargesCalculatorService().calculate({
    tradeDate,
    entryPremium: entryPrice,
    exitPremium: exitPrice,
    quantity,
    statutoryRateConfiguration,
    brokerageConfiguration,
  });

  console.log('\nHistorical Option Charges Reconciliation');
  console.log(`Contract: ${contract.tradingSymbol} | ${contract.instrumentKey} | expiry=${getMarketDate(contract.expiry)} | strike=${contract.strikePrice.toString()} | lotSize=${quantity}`);
  console.log(`Prices: currentLtp=${money(currentPremium)} | entry=${money(entryPrice)} | exit=${money(exitPrice)} | quantity=${quantity}`);
  printCharges('Broker API mapped', roundTrip.combinedCharges, roundTrip.totalCharges);
  console.log(`Broker API reported total: ${money(roundTrip.combinedReportedTotal)} | mapped/report difference=${money(roundTrip.reconciliationDifference)}`);
  printCharges(
    `Configured (${statutoryRateConfiguration.id}; ${brokerageConfiguration.id})`,
    configured,
    configured.totalCharges
  );
  console.log('Differences (configured - broker mapped):');
  chargeFields.forEach((field) => console.log(`${field}: ${money(configured[field] - roundTrip.combinedCharges[field])}`));
  const totalDifference = configured.totalCharges - roundTrip.totalCharges;
  const totalPercentageDifference = (totalDifference / roundTrip.totalCharges) * 100;
  console.log(`Total absolute difference: ${money(Math.abs(totalDifference))}`);
  console.log(`Total percentage difference: ${money(totalPercentageDifference)}%`);

  validateDifferences(roundTrip.combinedCharges, configured, roundTrip.totalCharges, configured.totalCharges);
  logger.info('Historical option charges reconciliation completed', {
    instrumentKey: contract.instrumentKey,
    totalDifference,
    totalPercentageDifference,
  });
}

run().catch((error) => {
  const errorMessage = error instanceof Error ? error.message : 'Unknown error';
  logger.error('Historical option charges reconciliation failed', { errorMessage });
  console.error('Historical option charges reconciliation failed.', errorMessage);
  process.exitCode = 1;
});
