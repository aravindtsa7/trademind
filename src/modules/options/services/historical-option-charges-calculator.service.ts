import {
  HistoricalOptionChargesCalculationRequest,
  HistoricalOptionChargesDto,
  HistoricalOptionBrokerageConfiguration,
  HistoricalOptionGstTaxableComponent,
  HistoricalOptionOtherCharge,
  HistoricalOptionRateUnit,
  HistoricalOptionStatutoryChargesRateConfiguration,
  HistoricalOptionTurnoverRate,
  HistoricalOptionTurnoverSide,
} from '../dto/historical-option-charges.dto';
import { OptionTradeCharges } from '../dto/option-trade-pnl.dto';

const crore = 10_000_000;
const marketDateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Kolkata',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

export default class HistoricalOptionChargesCalculatorService {
  calculate(request: HistoricalOptionChargesCalculationRequest): HistoricalOptionChargesDto {
    this.validateRequest(request);

    const { entryPremium, exitPremium, quantity, statutoryRateConfiguration, brokerageConfiguration } = request;
    const entryTurnover = entryPremium * quantity;
    const exitTurnover = exitPremium * quantity;
    const totalTurnover = entryTurnover + exitTurnover;
    const brokerage = brokerageConfiguration.brokeragePerExecutedOrder * brokerageConfiguration.numberOfOrders;
    const stt = this.calculateTurnoverCharge(
      this.getTurnoverForSide(statutoryRateConfiguration.stt.side, entryTurnover, exitTurnover),
      statutoryRateConfiguration.stt.rate
    );
    const exchangeTransactionCharges = this.calculateTurnoverCharge(
      totalTurnover,
      statutoryRateConfiguration.exchangeTransactionChargeRate
    );
    const sebiCharges = this.calculateTurnoverCharge(totalTurnover, statutoryRateConfiguration.sebiTurnoverRate);
    const stampDuty = this.calculateTurnoverCharge(
      this.getTurnoverForSide(statutoryRateConfiguration.stampDuty.side, entryTurnover, exitTurnover),
      statutoryRateConfiguration.stampDuty.rate
    );
    const otherCharges = this.calculateOtherCharges(
      statutoryRateConfiguration.otherCharges ?? [],
      entryTurnover,
      exitTurnover
    );
    const preGstCharges: Omit<OptionTradeCharges, 'gst'> = {
      brokerage,
      stt,
      exchangeTransactionCharges,
      sebiCharges,
      stampDuty,
      otherCharges,
    };
    const gstTaxableAmount = statutoryRateConfiguration.gst.taxableComponents.reduce(
      (total, component) => total + this.getTaxableComponentAmount(component, preGstCharges),
      0
    );
    const gst = this.calculatePercentageCharge(gstTaxableAmount, statutoryRateConfiguration.gst.rate);
    const charges: OptionTradeCharges = { ...preGstCharges, gst };
    const totalCharges = Object.values(charges).reduce((total, value) => total + value, 0);

    return {
      ...charges,
      totalCharges,
      entryTurnover,
      exitTurnover,
      totalTurnover,
      statutoryRateConfigurationId: statutoryRateConfiguration.id,
      statutoryEffectiveFrom: statutoryRateConfiguration.effectiveFrom,
      statutoryEffectiveTo: statutoryRateConfiguration.effectiveTo,
      brokerageConfigurationId: brokerageConfiguration.id,
      brokerageEffectiveFrom: brokerageConfiguration.effectiveFrom,
      brokerageEffectiveTo: brokerageConfiguration.effectiveTo,
    };
  }

  private validateRequest(request: HistoricalOptionChargesCalculationRequest): void {
    if (!request || typeof request !== 'object') {
      throw new Error('Historical option charges require a valid request.');
    }
    if (!(request.tradeDate instanceof Date) || Number.isNaN(request.tradeDate.getTime())) {
      throw new Error('Historical option charges require a valid trade date.');
    }
    if (!Number.isFinite(request.entryPremium) || request.entryPremium <= 0) {
      throw new Error('Historical option charges require a positive finite entry premium.');
    }
    if (!Number.isFinite(request.exitPremium) || request.exitPremium < 0) {
      throw new Error('Historical option charges require a non-negative finite exit premium.');
    }
    if (!Number.isInteger(request.quantity) || request.quantity <= 0) {
      throw new Error('Historical option charges require a positive integer quantity.');
    }
    const tradeDate = this.getMarketDate(request.tradeDate);
    this.validateStatutoryRateConfiguration(request.statutoryRateConfiguration, tradeDate);
    this.validateBrokerageConfiguration(request.brokerageConfiguration, tradeDate);
  }

  private validateStatutoryRateConfiguration(
    configuration: HistoricalOptionStatutoryChargesRateConfiguration,
    tradeDate: string
  ): void {
    if (!configuration || typeof configuration !== 'object' || !this.isNonEmptyString(configuration.id)) {
      throw new Error('Historical option charges require a statutory rate configuration identifier.');
    }
    if (!this.isValidDateString(configuration.effectiveFrom) ||
      (configuration.effectiveTo !== undefined && !this.isValidDateString(configuration.effectiveTo)) ||
      (configuration.effectiveTo !== undefined && configuration.effectiveFrom > configuration.effectiveTo)) {
      throw new Error('Historical option statutory charge configuration has an invalid effective date range.');
    }
    if (tradeDate < configuration.effectiveFrom ||
      (configuration.effectiveTo !== undefined && tradeDate > configuration.effectiveTo)) {
      throw new Error(`Historical option statutory charge configuration ${configuration.id} is not effective on ${tradeDate}.`);
    }
    this.validateSideRate(configuration.stt.side, configuration.stt.rate, 'stt');
    this.validateRate(configuration.exchangeTransactionChargeRate, 'exchangeTransactionChargeRate');
    this.validateRate(configuration.sebiTurnoverRate, 'sebiTurnoverRate');
    this.validateSideRate(configuration.stampDuty.side, configuration.stampDuty.rate, 'stampDuty');
    if (!Array.isArray(configuration.gst.taxableComponents) || configuration.gst.taxableComponents.length === 0) {
      throw new Error('Historical option GST must specify taxable components.');
    }
    if ((configuration.gst.rate as HistoricalOptionTurnoverRate).unit === 'PER_CRORE') {
      throw new Error('Historical option GST rate must use DECIMAL_FRACTION or PERCENT units.');
    }
    this.validateRate(configuration.gst.rate, 'gst.rate');
    configuration.gst.taxableComponents.forEach((component) => this.validateGstComponent(component));
    (configuration.otherCharges ?? []).forEach((charge) => this.validateOtherCharge(charge));
  }

  private validateBrokerageConfiguration(
    configuration: HistoricalOptionBrokerageConfiguration,
    tradeDate: string
  ): void {
    if (!configuration || typeof configuration !== 'object' || !this.isNonEmptyString(configuration.id)) {
      throw new Error('Historical option charges require a brokerage configuration identifier.');
    }
    if (!this.isValidDateString(configuration.effectiveFrom) ||
      (configuration.effectiveTo !== undefined && !this.isValidDateString(configuration.effectiveTo)) ||
      (configuration.effectiveTo !== undefined && configuration.effectiveFrom > configuration.effectiveTo)) {
      throw new Error('Historical option brokerage configuration has an invalid effective date range.');
    }
    if (tradeDate < configuration.effectiveFrom ||
      (configuration.effectiveTo !== undefined && tradeDate > configuration.effectiveTo)) {
      throw new Error(`Historical option brokerage configuration ${configuration.id} is not effective on ${tradeDate}.`);
    }
    if (!Number.isFinite(configuration.brokeragePerExecutedOrder) || configuration.brokeragePerExecutedOrder < 0) {
      throw new Error('Historical option brokeragePerExecutedOrder must be non-negative and finite.');
    }
    if (!Number.isInteger(configuration.numberOfOrders) || configuration.numberOfOrders <= 0) {
      throw new Error('Historical option brokerage numberOfOrders must be a positive integer.');
    }
  }

  private validateSideRate(side: HistoricalOptionTurnoverSide, rate: HistoricalOptionTurnoverRate, name: string): void {
    if (side !== 'BUY' && side !== 'SELL' && side !== 'TOTAL') {
      throw new Error(`Historical option ${name} side must be BUY, SELL, or TOTAL.`);
    }
    this.validateRate(rate, `${name}.rate`);
  }

  private validateRate(rate: HistoricalOptionTurnoverRate, name: string): void {
    if (!rate || typeof rate !== 'object' || !Number.isFinite(rate.value) || rate.value < 0) {
      throw new Error(`Historical option ${name} must have a non-negative finite value.`);
    }
    if (!this.isRateUnit(rate.unit)) {
      throw new Error(`Historical option ${name} has an unsupported rate unit.`);
    }
  }

  private validateGstComponent(component: HistoricalOptionGstTaxableComponent): void {
    if (!['BROKERAGE', 'STT', 'EXCHANGE_TRANSACTION_CHARGES', 'SEBI_CHARGES', 'STAMP_DUTY', 'OTHER_CHARGES'].includes(component)) {
      throw new Error('Historical option GST includes an unsupported taxable component.');
    }
  }

  private validateOtherCharge(charge: HistoricalOptionOtherCharge): void {
    if (!charge || typeof charge !== 'object' || !this.isNonEmptyString(charge.id)) {
      throw new Error('Historical option other charge requires an identifier.');
    }
    if (charge.kind === 'FLAT_RUPEE') {
      if (!Number.isFinite(charge.amount) || charge.amount < 0) {
        throw new Error('Historical option flat other charge must be non-negative and finite.');
      }
      return;
    }
    if (charge.kind === 'TURNOVER_RATE') {
      this.validateSideRate(charge.side, charge.rate, 'other charge');
      return;
    }
    throw new Error('Historical option other charge has an unsupported kind.');
  }

  private calculateOtherCharges(
    charges: readonly HistoricalOptionOtherCharge[],
    entryTurnover: number,
    exitTurnover: number
  ): number {
    return charges.reduce((total, charge) => {
      if (charge.kind === 'FLAT_RUPEE') return total + charge.amount;
      return total + this.calculateTurnoverCharge(
        this.getTurnoverForSide(charge.side, entryTurnover, exitTurnover),
        charge.rate
      );
    }, 0);
  }

  private calculateTurnoverCharge(turnover: number, rate: HistoricalOptionTurnoverRate): number {
    switch (rate.unit) {
      case 'DECIMAL_FRACTION':
        return turnover * rate.value;
      case 'PERCENT':
        return turnover * (rate.value / 100);
      case 'PER_CRORE':
        return (turnover / crore) * rate.value;
    }
  }

  private calculatePercentageCharge(amount: number, rate: HistoricalOptionTurnoverRate): number {
    return rate.unit === 'DECIMAL_FRACTION' ? amount * rate.value : amount * (rate.value / 100);
  }

  private getTurnoverForSide(
    side: HistoricalOptionTurnoverSide,
    entryTurnover: number,
    exitTurnover: number
  ): number {
    if (side === 'BUY') return entryTurnover;
    if (side === 'SELL') return exitTurnover;
    return entryTurnover + exitTurnover;
  }

  private getTaxableComponentAmount(
    component: HistoricalOptionGstTaxableComponent,
    charges: Omit<OptionTradeCharges, 'gst'>
  ): number {
    switch (component) {
      case 'BROKERAGE': return charges.brokerage;
      case 'STT': return charges.stt;
      case 'EXCHANGE_TRANSACTION_CHARGES': return charges.exchangeTransactionCharges;
      case 'SEBI_CHARGES': return charges.sebiCharges;
      case 'STAMP_DUTY': return charges.stampDuty;
      case 'OTHER_CHARGES': return charges.otherCharges;
    }
  }

  private getMarketDate(date: Date): string {
    const values = Object.fromEntries(
      marketDateFormatter.formatToParts(date).map((part) => [part.type, part.value])
    );
    return `${values.year}-${values.month}-${values.day}`;
  }

  private isRateUnit(value: unknown): value is HistoricalOptionRateUnit {
    return value === 'DECIMAL_FRACTION' || value === 'PERCENT' || value === 'PER_CRORE';
  }

  private isValidDateString(value: unknown): value is string {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const [year, month, day] = value.split('-').map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  }

  private isNonEmptyString(value: unknown): value is string {
    return typeof value === 'string' && value.trim().length > 0;
  }
}
