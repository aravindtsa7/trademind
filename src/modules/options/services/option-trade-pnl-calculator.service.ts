import {
  OptionTradeCharges,
  OptionTradePnlCalculationRequest,
  OptionTradePnlDto,
} from '../dto/option-trade-pnl.dto';

const chargeFields: readonly (keyof OptionTradeCharges)[] = [
  'brokerage',
  'stt',
  'exchangeTransactionCharges',
  'sebiCharges',
  'gst',
  'stampDuty',
  'otherCharges',
];

export default class OptionTradePnlCalculatorService {
  calculate(request: OptionTradePnlCalculationRequest): OptionTradePnlDto {
    this.validateRequest(request);

    const entryValue = request.entryPremium * request.quantity;
    const exitValue = request.exitPremium * request.quantity;
    const grossPnl = exitValue - entryValue;
    const charges = this.copyCharges(request.charges);
    const totalCharges = chargeFields.reduce((total, field) => total + charges[field], 0);
    const netPnl = grossPnl - totalCharges;

    return {
      entryPremium: request.entryPremium,
      exitPremium: request.exitPremium,
      quantity: request.quantity,
      entryValue,
      exitValue,
      grossPnl,
      grossReturnPercent: (grossPnl / entryValue) * 100,
      charges,
      totalCharges,
      netPnl,
      netReturnPercent: (netPnl / entryValue) * 100,
    };
  }

  private validateRequest(request: OptionTradePnlCalculationRequest): void {
    if (!request || typeof request !== 'object') {
      throw new Error('Option trade P&L calculation requires a valid request.');
    }

    if (!Number.isFinite(request.entryPremium) || request.entryPremium <= 0) {
      throw new Error('Option trade P&L calculation requires a positive finite entry premium.');
    }

    if (!Number.isFinite(request.exitPremium) || request.exitPremium < 0) {
      throw new Error('Option trade P&L calculation requires a non-negative finite exit premium.');
    }

    if (!Number.isInteger(request.quantity) || request.quantity <= 0) {
      throw new Error('Option trade P&L calculation requires a positive integer quantity.');
    }

    if (!request.charges || typeof request.charges !== 'object') {
      throw new Error('Option trade P&L calculation requires a complete charges breakdown.');
    }

    chargeFields.forEach((field) => {
      const charge = request.charges[field];
      if (!Number.isFinite(charge) || charge < 0) {
        throw new Error(`Option trade P&L calculation requires a non-negative finite ${field} charge.`);
      }
    });
  }

  private copyCharges(charges: OptionTradeCharges): OptionTradeCharges {
    return {
      brokerage: charges.brokerage,
      stt: charges.stt,
      exchangeTransactionCharges: charges.exchangeTransactionCharges,
      sebiCharges: charges.sebiCharges,
      gst: charges.gst,
      stampDuty: charges.stampDuty,
      otherCharges: charges.otherCharges,
    };
  }
}
