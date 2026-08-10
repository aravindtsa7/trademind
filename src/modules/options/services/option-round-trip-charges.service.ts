import UpstoxOptionChargesClient from '../client/upstox-option-charges.client';
import { OptionTradeCharges } from '../dto/option-trade-pnl.dto';
import {
  OptionRoundTripChargesDto,
  OptionRoundTripChargesRequestDto,
} from '../dto/option-round-trip-charges.dto';
import { UpstoxOptionChargesDto } from '../dto/upstox-option-charges.dto';

const chargeFields: readonly (keyof OptionTradeCharges)[] = [
  'brokerage',
  'stt',
  'exchangeTransactionCharges',
  'sebiCharges',
  'gst',
  'stampDuty',
  'otherCharges',
];

export default class OptionRoundTripChargesService {
  constructor(private readonly chargesClient: UpstoxOptionChargesClient) {}

  async calculate(request: OptionRoundTripChargesRequestDto): Promise<OptionRoundTripChargesDto> {
    this.validateRequest(request);

    const entryCharges = await this.chargesClient.fetchCharges({
      instrumentToken: request.instrumentKey,
      quantity: request.quantity,
      product: request.product,
      transactionType: 'BUY',
      price: request.entryPrice,
    });
    const exitCharges = await this.chargesClient.fetchCharges({
      instrumentToken: request.instrumentKey,
      quantity: request.quantity,
      product: request.product,
      transactionType: 'SELL',
      price: request.exitPrice,
    });
    const combinedCharges = this.combineCharges(entryCharges, exitCharges);
    const totalCharges = this.sumCharges(combinedCharges);
    const combinedReportedTotal = entryCharges.reportedTotalCharges + exitCharges.reportedTotalCharges;

    return {
      entryCharges,
      exitCharges,
      combinedCharges,
      totalCharges,
      entryReportedTotal: entryCharges.reportedTotalCharges,
      exitReportedTotal: exitCharges.reportedTotalCharges,
      combinedReportedTotal,
      reconciliationDifference: combinedReportedTotal - totalCharges,
    };
  }

  private validateRequest(request: OptionRoundTripChargesRequestDto): void {
    if (!request || typeof request !== 'object') {
      throw new Error('Round-trip option charges require a valid request.');
    }

    if (typeof request.instrumentKey !== 'string' || !request.instrumentKey.trim()) {
      throw new Error('Round-trip option charges require an instrument key.');
    }

    if (!Number.isInteger(request.quantity) || request.quantity <= 0) {
      throw new Error('Round-trip option charges require a positive integer quantity.');
    }

    if (typeof request.product !== 'string' || !request.product.trim()) {
      throw new Error('Round-trip option charges require an order product.');
    }

    if (!Number.isFinite(request.entryPrice) || request.entryPrice < 0 || !Number.isFinite(request.exitPrice) || request.exitPrice < 0) {
      throw new Error('Round-trip option charges require non-negative finite entry and exit prices.');
    }
  }

  private combineCharges(
    entryCharges: UpstoxOptionChargesDto,
    exitCharges: UpstoxOptionChargesDto
  ): OptionTradeCharges {
    return {
      brokerage: entryCharges.brokerage + exitCharges.brokerage,
      stt: entryCharges.stt + exitCharges.stt,
      exchangeTransactionCharges: entryCharges.exchangeTransactionCharges + exitCharges.exchangeTransactionCharges,
      sebiCharges: entryCharges.sebiCharges + exitCharges.sebiCharges,
      gst: entryCharges.gst + exitCharges.gst,
      stampDuty: entryCharges.stampDuty + exitCharges.stampDuty,
      otherCharges: entryCharges.otherCharges + exitCharges.otherCharges,
    };
  }

  private sumCharges(charges: OptionTradeCharges): number {
    return chargeFields.reduce((total, field) => total + charges[field], 0);
  }
}
