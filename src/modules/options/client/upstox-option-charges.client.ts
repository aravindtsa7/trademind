import axios, { AxiosInstance } from 'axios';
import logger from '../../../core/logger/logger';
import {
  UpstoxBrokerageDetailsApiResponseDto,
  UpstoxOptionChargesDto,
  UpstoxOptionChargesRequestDto,
} from '../dto/upstox-option-charges.dto';

const brokerageDetailsUrl = 'https://api.upstox.com/v2/charges/brokerage';

export default class UpstoxOptionChargesClient {
  private readonly axios: AxiosInstance;
  private readonly accessToken: string;

  constructor(accessToken: string) {
    this.accessToken = accessToken.trim();
    if (!this.accessToken) {
      throw new Error('An Upstox OAuth access token is required for option charge details.');
    }

    this.axios = axios.create({ timeout: 10_000 });
  }

  async fetchCharges(request: UpstoxOptionChargesRequestDto): Promise<UpstoxOptionChargesDto> {
    this.validateRequest(request);

    const startedAt = Date.now();
    const url = this.createUrl(request);
    const context = {
      instrumentToken: request.instrumentToken,
      quantity: request.quantity,
      product: request.product,
      transactionType: request.transactionType,
      price: request.price,
      url,
    };

    try {
      logger.info('Requesting Upstox option charge details', context);
      const response = await this.axios.get<UpstoxBrokerageDetailsApiResponseDto>(url, {
        headers: this.getHeaders(),
      });
      const charges = this.mapResponse(response.data);

      logger.info('Upstox option charge details received', {
        ...context,
        httpStatus: response.status,
        durationMs: Date.now() - startedAt,
        reportedTotalCharges: charges.reportedTotalCharges,
      });

      return charges;
    } catch (error) {
      this.logFailure('Failed to fetch Upstox option charge details', error, {
        ...context,
        durationMs: Date.now() - startedAt,
      });
      throw error;
    }
  }

  private getHeaders(): Record<string, string> {
    return {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.accessToken}`,
    };
  }

  private createUrl(request: UpstoxOptionChargesRequestDto): string {
    const parameters = new URLSearchParams({
      instrument_token: request.instrumentToken,
      quantity: String(request.quantity),
      product: request.product,
      transaction_type: request.transactionType,
      price: String(request.price),
    });

    return `${brokerageDetailsUrl}?${parameters.toString()}`;
  }

  private validateRequest(request: UpstoxOptionChargesRequestDto): void {
    if (!request || typeof request !== 'object') {
      throw new Error('Upstox option charge details require a valid request.');
    }

    if (typeof request.instrumentToken !== 'string' || !request.instrumentToken.trim()) {
      throw new Error('An Upstox option instrument token is required for charge details.');
    }

    if (!Number.isInteger(request.quantity) || request.quantity <= 0) {
      throw new Error('Upstox option charge quantity must be a positive integer.');
    }

    if (typeof request.product !== 'string' || !request.product.trim()) {
      throw new Error('An Upstox order product is required for option charge details.');
    }

    if (request.transactionType !== 'BUY' && request.transactionType !== 'SELL') {
      throw new Error('Upstox option charge transaction type must be BUY or SELL.');
    }

    if (!Number.isFinite(request.price) || request.price < 0) {
      throw new Error('Upstox option charge price must be a non-negative finite number.');
    }
  }

  private mapResponse(response: unknown): UpstoxOptionChargesDto {
    if (!response || typeof response !== 'object') {
      throw new Error('Upstox option charge response is invalid.');
    }

    const payload = response as Partial<UpstoxBrokerageDetailsApiResponseDto>;
    const sourceCharges = payload.data?.charges;
    if (payload.status !== 'success' || !sourceCharges || typeof sourceCharges !== 'object') {
      throw new Error('Upstox option charge response was not successful.');
    }

    const { taxes, other_charges: otherCharges } = sourceCharges;
    if (!taxes || typeof taxes !== 'object' || !otherCharges || typeof otherCharges !== 'object') {
      throw new Error('Upstox option charge response did not contain a valid charge breakdown.');
    }

    this.assertNonNegativeNumber(sourceCharges.total, 'total');
    this.assertNonNegativeNumber(sourceCharges.brokerage, 'brokerage');
    this.assertNonNegativeNumber(taxes.stt, 'taxes.stt');
    this.assertNonNegativeNumber(taxes.gst, 'taxes.gst');
    this.assertNonNegativeNumber(taxes.stamp_duty, 'taxes.stamp_duty');
    this.assertNonNegativeNumber(otherCharges.transaction, 'other_charges.transaction');
    this.assertNonNegativeNumber(otherCharges.sebi_turnover, 'other_charges.sebi_turnover');

    const additionalOtherCharges = Object.entries(otherCharges)
      .filter(([name]) => name !== 'transaction' && name !== 'sebi_turnover')
      .reduce((total, [name, value]) => {
        this.assertNonNegativeNumber(value, `other_charges.${name}`);
        return total + value;
      }, 0);

    return {
      brokerage: sourceCharges.brokerage,
      stt: taxes.stt,
      exchangeTransactionCharges: otherCharges.transaction,
      sebiCharges: otherCharges.sebi_turnover,
      gst: taxes.gst,
      stampDuty: taxes.stamp_duty,
      otherCharges: additionalOtherCharges,
      reportedTotalCharges: sourceCharges.total,
    };
  }

  private assertNonNegativeNumber(value: unknown, field: string): asserts value is number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new Error(`Upstox option charge response contains an invalid ${field} value.`);
    }
  }

  private logFailure(message: string, error: unknown, context: Record<string, unknown>): void {
    logger.error(message, {
      ...context,
      ...(axios.isAxiosError(error)
        ? {
            httpStatus: error.response?.status,
            responseData: error.response?.data,
          }
        : {}),
      errorMessage: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}
