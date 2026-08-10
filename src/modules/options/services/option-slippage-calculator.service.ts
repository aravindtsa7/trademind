import {
  OptionSlippageCalculationRequest,
  OptionSlippageDto,
} from '../dto/option-slippage.dto';

export default class OptionSlippageCalculatorService {
  calculate(request: OptionSlippageCalculationRequest): OptionSlippageDto {
    this.validateRequest(request);

    const adjustedEntryPremium = request.entryPremium * (1 + request.slippage.entrySlippagePercent / 100);
    const adjustedExitPremium = request.exitPremium * (1 - request.slippage.exitSlippagePercent / 100);

    return {
      originalEntryPremium: request.entryPremium,
      originalExitPremium: request.exitPremium,
      adjustedEntryPremium,
      adjustedExitPremium,
      entrySlippageAmount: adjustedEntryPremium - request.entryPremium,
      exitSlippageAmount: request.exitPremium - adjustedExitPremium,
      entrySlippagePercent: request.slippage.entrySlippagePercent,
      exitSlippagePercent: request.slippage.exitSlippagePercent,
    };
  }

  private validateRequest(request: OptionSlippageCalculationRequest): void {
    if (!request || typeof request !== 'object') {
      throw new Error('Option slippage calculation requires a valid request.');
    }
    if (!Number.isFinite(request.entryPremium) || request.entryPremium <= 0) {
      throw new Error('Option slippage calculation requires a positive finite entry premium.');
    }
    if (!Number.isFinite(request.exitPremium) || request.exitPremium < 0) {
      throw new Error('Option slippage calculation requires a non-negative finite exit premium.');
    }
    if (!request.slippage || typeof request.slippage !== 'object') {
      throw new Error('Option slippage calculation requires a slippage configuration.');
    }
    if (!Number.isFinite(request.slippage.entrySlippagePercent) || request.slippage.entrySlippagePercent < 0 ||
      !Number.isFinite(request.slippage.exitSlippagePercent) || request.slippage.exitSlippagePercent < 0) {
      throw new Error('Option slippage percentages must be non-negative and finite.');
    }
    if (request.exitPremium * (1 - request.slippage.exitSlippagePercent / 100) < 0) {
      throw new Error('Option slippage configuration produces a negative adjusted exit premium.');
    }
  }
}
