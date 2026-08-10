import { randomUUID } from 'crypto';
import { PaperOrderManager } from '../interfaces/paper-order.interface';
import { ClosePaperOrderDto, CreatePaperOrderDto } from '../dto/paper-order.dto';
import {
  PaperOrder,
  PaperOrderExit,
  PaperOrderStatus,
} from '../types/paper-trading.types';

const activeStatuses = new Set<PaperOrderStatus>([PaperOrderStatus.PENDING, PaperOrderStatus.OPEN]);
const closedStatuses = new Set<PaperOrderStatus>([
  PaperOrderStatus.TARGET_EXIT,
  PaperOrderStatus.STOP_EXIT,
  PaperOrderStatus.TIME_EXIT,
  PaperOrderStatus.CANCELLED,
]);

/**
 * Pure in-memory lifecycle manager. It deliberately does not calculate P&L,
 * place orders, or consume market data; callers supply any close information.
 */
export default class PaperOrderManagerService implements PaperOrderManager {
  private readonly orders = new Map<string, PaperOrder>();

  create(input: CreatePaperOrderDto): PaperOrder {
    this.validateCreateInput(input);
    const targetPremium = input.entry.simulatedEntryPremium * (1 + input.exitConfiguration.targetPercent / 100);
    const stopPremium = input.entry.simulatedEntryPremium * (1 - input.exitConfiguration.stopLossPercent / 100);
    const order: PaperOrder = {
      id: randomUUID(),
      status: PaperOrderStatus.PENDING,
      signalTimestamp: new Date(input.signalTimestamp.getTime()),
      signalType: input.signalType,
      contract: {
        ...input.contract,
        expiry: new Date(input.contract.expiry.getTime()),
      },
      entry: {
        ...input.entry,
        entryTimestamp: new Date(input.entry.entryTimestamp.getTime()),
      },
      exitConfiguration: { ...input.exitConfiguration },
      targetPremium,
      stopPremium,
    };
    this.orders.set(order.id, order);
    return cloneOrder(order);
  }

  markOpen(id: string): PaperOrder {
    return this.updateStatus(id, PaperOrderStatus.OPEN);
  }

  getById(id: string): PaperOrder | undefined {
    const order = this.orders.get(id);
    return order ? cloneOrder(order) : undefined;
  }

  getActiveOrders(): PaperOrder[] {
    return Array.from(this.orders.values())
      .filter((order) => activeStatuses.has(order.status))
      .map(cloneOrder);
  }

  updateStatus(id: string, status: PaperOrderStatus): PaperOrder {
    const order = this.requireOrder(id);
    if (!this.isTransitionAllowed(order.status, status)) {
      throw new Error(`Invalid paper-order transition: ${order.status} -> ${status}.`);
    }
    if (closedStatuses.has(status) && status !== PaperOrderStatus.CANCELLED) {
      throw new Error(`Use close() to transition an OPEN paper order to ${status}.`);
    }
    const updated: PaperOrder = { ...order, status };
    this.orders.set(id, updated);
    return cloneOrder(updated);
  }

  close(id: string, input: ClosePaperOrderDto): PaperOrder {
    const order = this.requireOrder(id);
    if (order.status !== PaperOrderStatus.OPEN) {
      throw new Error(`Only OPEN paper orders can close; current status is ${order.status}.`);
    }
    this.validateExitInput(input, order.entry.entryTimestamp);
    const exit: PaperOrderExit = {
      ...input,
      exitTimestamp: new Date(input.exitTimestamp.getTime()),
      charges: input.charges ? { ...input.charges } : undefined,
    };
    const updated: PaperOrder = { ...order, status: input.exitReason, exit };
    this.orders.set(id, updated);
    return cloneOrder(updated);
  }

  private requireOrder(id: string): PaperOrder {
    if (typeof id !== 'string' || id.trim().length === 0) throw new Error('Paper order id must be a non-empty string.');
    const order = this.orders.get(id);
    if (!order) throw new Error(`Paper order ${id} was not found.`);
    return order;
  }

  private isTransitionAllowed(from: PaperOrderStatus, to: PaperOrderStatus): boolean {
    if (from === PaperOrderStatus.PENDING) return to === PaperOrderStatus.OPEN || to === PaperOrderStatus.CANCELLED;
    return false;
  }

  private validateCreateInput(input: CreatePaperOrderDto): void {
    if (!input || typeof input !== 'object') throw new Error('Paper order input is required.');
    if (!(input.signalTimestamp instanceof Date) || Number.isNaN(input.signalTimestamp.getTime())) throw new Error('signalTimestamp must be a valid Date.');
    if (input.signalType !== 'BUY_CE' && input.signalType !== 'BUY_PE') throw new Error('signalType must be BUY_CE or BUY_PE.');
    if (!(input.contract.expiry instanceof Date) || Number.isNaN(input.contract.expiry.getTime())) throw new Error('contract.expiry must be a valid Date.');
    if (!input.contract.instrumentKey.trim() || !input.contract.tradingSymbol.trim()) throw new Error('Contract instrumentKey and tradingSymbol are required.');
    if (input.contract.optionType !== 'CE' && input.contract.optionType !== 'PE') throw new Error('contract.optionType must be CE or PE.');
    this.positiveFinite(input.contract.strikePrice, 'contract.strikePrice');
    this.positiveInteger(input.contract.lotSize, 'contract.lotSize');
    this.positiveInteger(input.contract.quantity, 'contract.quantity');
    if (!(input.entry.entryTimestamp instanceof Date) || Number.isNaN(input.entry.entryTimestamp.getTime())) throw new Error('entry.entryTimestamp must be a valid Date.');
    this.positiveFinite(input.entry.observedEntryPremium, 'entry.observedEntryPremium');
    this.positiveFinite(input.entry.simulatedEntryPremium, 'entry.simulatedEntryPremium');
    this.positiveFinite(input.exitConfiguration.targetPercent, 'exitConfiguration.targetPercent');
    this.positiveFinite(input.exitConfiguration.stopLossPercent, 'exitConfiguration.stopLossPercent');
    this.positiveInteger(input.exitConfiguration.maximumHoldingMinutes, 'exitConfiguration.maximumHoldingMinutes');
    const stopPremium = input.entry.simulatedEntryPremium * (1 - input.exitConfiguration.stopLossPercent / 100);
    if (stopPremium < 0) throw new Error('stopLossPercent cannot produce a negative stop premium.');
  }

  private validateExitInput(input: ClosePaperOrderDto, entryTimestamp: Date): void {
    if (!input || typeof input !== 'object') throw new Error('Paper order close input is required.');
    if (input.exitReason !== PaperOrderStatus.TARGET_EXIT && input.exitReason !== PaperOrderStatus.STOP_EXIT && input.exitReason !== PaperOrderStatus.TIME_EXIT) throw new Error('exitReason must be TARGET_EXIT, STOP_EXIT, or TIME_EXIT.');
    if (!(input.exitTimestamp instanceof Date) || Number.isNaN(input.exitTimestamp.getTime()) || input.exitTimestamp.getTime() < entryTimestamp.getTime()) throw new Error('exitTimestamp must be valid and on or after entryTimestamp.');
    this.nonNegativeFinite(input.observedExitPremium, 'observedExitPremium');
    this.nonNegativeFinite(input.simulatedExitPremium, 'simulatedExitPremium');
    if (input.grossPnl !== undefined) this.finite(input.grossPnl, 'grossPnl');
    if (input.netPnl !== undefined) this.finite(input.netPnl, 'netPnl');
    if (input.charges) Object.entries(input.charges).forEach(([name, value]) => this.nonNegativeFinite(value, `charges.${name}`));
  }

  private positiveFinite(value: number, field: string): void { if (!Number.isFinite(value) || value <= 0) throw new Error(`${field} must be positive and finite.`); }
  private nonNegativeFinite(value: number, field: string): void { if (!Number.isFinite(value) || value < 0) throw new Error(`${field} must be non-negative and finite.`); }
  private finite(value: number, field: string): void { if (!Number.isFinite(value)) throw new Error(`${field} must be finite.`); }
  private positiveInteger(value: number, field: string): void { if (!Number.isInteger(value) || value <= 0) throw new Error(`${field} must be a positive integer.`); }
}

function cloneOrder(order: PaperOrder): PaperOrder {
  return {
    ...order,
    signalTimestamp: new Date(order.signalTimestamp.getTime()),
    contract: { ...order.contract, expiry: new Date(order.contract.expiry.getTime()) },
    entry: { ...order.entry, entryTimestamp: new Date(order.entry.entryTimestamp.getTime()) },
    exitConfiguration: { ...order.exitConfiguration },
    exit: order.exit ? { ...order.exit, exitTimestamp: new Date(order.exit.exitTimestamp.getTime()), charges: order.exit.charges ? { ...order.exit.charges } : undefined } : undefined,
  };
}

