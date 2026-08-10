import axios, { AxiosInstance } from 'axios';
import logger from '../../../core/logger/logger';
import {
  UpstoxExpiredInstrumentsApiResponseDto,
  UpstoxExpiredOptionContractApiDto,
} from '../dto/upstox-expired-option.dto';
import { OptionContract, OptionContractType } from '../types';

const expiredInstrumentsBaseUrl = 'https://api.upstox.com/v2/expired-instruments';

export default class UpstoxExpiredOptionClient {
  private readonly axios: AxiosInstance;
  private readonly accessToken: string;

  constructor(accessToken: string) {
    this.accessToken = accessToken.trim();
    if (!this.accessToken) {
      throw new Error('An Upstox OAuth access token is required for expired option contracts.');
    }

    this.axios = axios.create({ timeout: 10_000 });
  }

  async fetchAvailableExpiries(underlyingInstrumentKey: string): Promise<string[]> {
    const startedAt = Date.now();
    const url = this.createUrl('/expiries', { instrument_key: underlyingInstrumentKey });

    try {
      logger.info('Requesting Upstox expired instrument expiries', {
        underlyingInstrumentKey,
        url,
      });

      const response = await this.axios.get<UpstoxExpiredInstrumentsApiResponseDto<unknown>>(url, {
        headers: this.getHeaders(),
      });
      const expiries = this.validateExpiriesResponse(response.data);

      logger.info('Upstox expired instrument expiries received', {
        underlyingInstrumentKey,
        expiryCount: expiries.length,
        durationMs: Date.now() - startedAt,
      });

      return expiries;
    } catch (error) {
      this.logFailure('Failed to fetch Upstox expired instrument expiries', error, {
        underlyingInstrumentKey,
        url,
        durationMs: Date.now() - startedAt,
      });
      throw error;
    }
  }

  async fetchExpiredOptionContracts(
    underlyingInstrumentKey: string,
    expiryDate: string
  ): Promise<OptionContract[]> {
    const startedAt = Date.now();
    const url = this.createUrl('/option/contract', {
      instrument_key: underlyingInstrumentKey,
      expiry_date: expiryDate,
    });

    try {
      logger.info('Requesting Upstox expired option contracts', {
        underlyingInstrumentKey,
        expiryDate,
        url,
      });

      const response = await this.axios.get<UpstoxExpiredInstrumentsApiResponseDto<unknown>>(url, {
        headers: this.getHeaders(),
      });
      const contracts = this.validateContractsResponse(response.data).map((contract) =>
        this.mapContract(contract)
      );

      logger.info('Upstox expired option contracts received', {
        underlyingInstrumentKey,
        expiryDate,
        contractCount: contracts.length,
        durationMs: Date.now() - startedAt,
      });

      return contracts;
    } catch (error) {
      this.logFailure('Failed to fetch Upstox expired option contracts', error, {
        underlyingInstrumentKey,
        expiryDate,
        url,
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

  private createUrl(path: string, parameters: Record<string, string>): string {
    return `${expiredInstrumentsBaseUrl}${path}?${new URLSearchParams(parameters).toString()}`;
  }

  private validateExpiriesResponse(response: unknown): string[] {
    const data = this.getSuccessfulResponseData(response, 'expired instrument expiries');
    if (!Array.isArray(data) || data.length === 0 || !data.every((expiry) => this.isValidDateString(expiry))) {
      throw new Error('Upstox expired instrument expiries response did not contain valid expiry dates.');
    }

    return [...data];
  }

  private validateContractsResponse(response: unknown): UpstoxExpiredOptionContractApiDto[] {
    const data = this.getSuccessfulResponseData(response, 'expired option contracts');
    if (
      !Array.isArray(data) ||
      data.length === 0 ||
      !data.every((contract) => this.isValidContract(contract))
    ) {
      throw new Error('Upstox expired option contracts response did not contain valid option contracts.');
    }

    return data;
  }

  private getSuccessfulResponseData(response: unknown, responseName: string): unknown {
    if (!response || typeof response !== 'object') {
      throw new Error(`Upstox ${responseName} response is invalid.`);
    }

    const payload = response as Partial<UpstoxExpiredInstrumentsApiResponseDto<unknown>>;
    if (payload.status !== 'success') {
      throw new Error(`Upstox ${responseName} response was not successful.`);
    }

    return payload.data;
  }

  private isValidContract(value: unknown): value is UpstoxExpiredOptionContractApiDto {
    if (!value || typeof value !== 'object') {
      return false;
    }

    const contract = value as Partial<UpstoxExpiredOptionContractApiDto>;

    return (
      this.isNonEmptyString(contract.instrument_key) &&
      this.isNonEmptyString(contract.trading_symbol) &&
      this.isNonEmptyString(contract.underlying_symbol) &&
      this.isNonEmptyString(contract.exchange) &&
      this.isNonEmptyString(contract.segment) &&
      this.isValidDateString(contract.expiry) &&
      this.isOptionType(contract.instrument_type) &&
      typeof contract.strike_price === 'number' &&
      Number.isFinite(contract.strike_price) &&
      contract.strike_price > 0
    );
  }

  private mapContract(contract: UpstoxExpiredOptionContractApiDto): OptionContract {
    const lotSize = this.getValidLotSize(contract.lot_size);

    return {
      instrumentKey: contract.instrument_key,
      tradingSymbol: contract.trading_symbol,
      underlying: contract.underlying_symbol,
      strikePrice: contract.strike_price,
      expiry: this.toExpiryDate(contract.expiry),
      optionType: this.toOptionType(contract.instrument_type),
      exchange: contract.exchange,
      segment: contract.segment,
      ...(lotSize === undefined ? {} : { lotSize }),
    };
  }

  private getValidLotSize(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value > 0
      ? value
      : undefined;
  }

  private isOptionType(value: unknown): value is OptionContractType {
    return value === 'CE' || value === 'PE';
  }

  private toOptionType(value: string): OptionContractType {
    if (!this.isOptionType(value)) {
      throw new Error('Upstox expired option contract contains an unsupported option type.');
    }

    return value;
  }

  private isValidDateString(value: unknown): value is string {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      return false;
    }

    const [year, month, day] = value.split('-').map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));

    return (
      date.getUTCFullYear() === year &&
      date.getUTCMonth() === month - 1 &&
      date.getUTCDate() === day
    );
  }

  private toExpiryDate(expiry: string): Date {
    return new Date(`${expiry}T00:00:00+05:30`);
  }

  private isNonEmptyString(value: unknown): value is string {
    return typeof value === 'string' && value.trim().length > 0;
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
      error,
    });
  }
}
