import { StrategySignal } from '../../strategies/dto/strategy-signal.dto';
import {
  OptionContract,
  OptionContractSelectionRequest,
  OptionContractSelectionResult,
  OptionContractType,
} from '../types';

interface EligibleContract {
  contract: OptionContract;
  expiryDate: string;
}

export default class OptionContractSelectorService {
  select(request: OptionContractSelectionRequest): OptionContractSelectionResult {
    this.validateRequest(request);

    const matchingUnderlying = request.contracts.filter(
      (contract) => contract.underlying === request.underlying
    );
    if (matchingUnderlying.length === 0) {
      throw new Error(`No option contracts match underlying ${request.underlying}.`);
    }

    const optionType = this.getOptionType(request.signal);
    const matchingOptionType = matchingUnderlying.filter((contract) => contract.optionType === optionType);
    if (matchingOptionType.length === 0) {
      throw new Error(`No ${optionType} option contracts match underlying ${request.underlying}.`);
    }

    const signalDate = this.getIstDate(request.timestamp);
    const nonExpiredContracts = matchingOptionType.flatMap((contract) => {
      const expiryDate = this.getValidIstDate(contract.expiry);

      return expiryDate !== null && expiryDate >= signalDate ? [{ contract, expiryDate }] : [];
    });
    if (nonExpiredContracts.length === 0) {
      throw new Error('No non-expired option expiry is available for the signal date.');
    }

    const nearestExpiryDate = nonExpiredContracts.reduce(
      (nearest, candidate) => (candidate.expiryDate < nearest ? candidate.expiryDate : nearest),
      nonExpiredContracts[0].expiryDate
    );
    const nearestExpiryContracts = nonExpiredContracts.filter(
      (candidate) => candidate.expiryDate === nearestExpiryDate
    );
    const validStrikeContracts = nearestExpiryContracts.filter((candidate) =>
      this.isValidStrike(candidate.contract.strikePrice)
    );
    if (validStrikeContracts.length === 0) {
      throw new Error('No valid option strike is available for the nearest expiry.');
    }

    const selected = [...validStrikeContracts].sort((left, right) => {
      const leftDistance = Math.abs(left.contract.strikePrice - request.spotPrice);
      const rightDistance = Math.abs(right.contract.strikePrice - request.spotPrice);

      return (
        leftDistance - rightDistance ||
        left.contract.strikePrice - right.contract.strikePrice ||
        left.contract.instrumentKey.localeCompare(right.contract.instrumentKey) ||
        left.contract.tradingSymbol.localeCompare(right.contract.tradingSymbol)
      );
    })[0].contract;

    return {
      instrumentKey: selected.instrumentKey,
      tradingSymbol: selected.tradingSymbol,
      underlying: selected.underlying,
      optionType: selected.optionType,
      strikePrice: selected.strikePrice,
      expiry: selected.expiry,
      spotPrice: request.spotPrice,
      strikeDistance: Math.abs(selected.strikePrice - request.spotPrice),
    };
  }

  private validateRequest(request: OptionContractSelectionRequest): void {
    if (!Number.isFinite(request.spotPrice) || request.spotPrice <= 0) {
      throw new Error('Option contract selection requires a positive finite spot price.');
    }

    if (!(request.timestamp instanceof Date) || Number.isNaN(request.timestamp.getTime())) {
      throw new Error('Option contract selection requires a valid timestamp.');
    }

    this.getOptionType(request.signal);

    if (request.contracts.length === 0) {
      throw new Error('Option contract selection requires at least one contract.');
    }
  }

  private getOptionType(signal: unknown): OptionContractType {
    if (signal === StrategySignal.BUY_CE) {
      return 'CE';
    }

    if (signal === StrategySignal.BUY_PE) {
      return 'PE';
    }

    throw new Error('Option contract selection supports only BUY_CE and BUY_PE signals.');
  }

  private getValidIstDate(date: Date): string | null {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
      return null;
    }

    return this.getIstDate(date);
  }

  private getIstDate(date: Date): string {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Kolkata',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(date);
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));

    return `${values.year}-${values.month}-${values.day}`;
  }

  private isValidStrike(strikePrice: number): boolean {
    return Number.isFinite(strikePrice) && strikePrice > 0;
  }
}
