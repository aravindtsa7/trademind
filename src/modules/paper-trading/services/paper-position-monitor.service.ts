import PaperOrderManagerService from './paper-order-manager.service';
import PaperPortfolioService from './paper-portfolio.service';
import { PaperExecutionFillSummary } from '../dto/paper-fill-model.dto';
import ExecutionEngineService from '../../execution/execution-engine.service';
import { ExecutionFaultInjector, noExecutionFaults } from '../../execution/execution-fault-injection';
import {
  PaperOrderStatus,
  PaperOrder,
  PaperPositionMonitoringResult,
  PaperPremiumUpdate,
} from '../types/paper-trading.types';

/**
 * Evaluates observed live premiums for existing OPEN paper orders. It owns no
 * market connection and intentionally leaves slippage, charges, and P&L unset.
 */
export default class PaperPositionMonitorService {
  constructor(
    private readonly orderManager: PaperOrderManagerService,
    private readonly portfolio?: PaperPortfolioService,
    private readonly sessionDateFor = istDate,
    private readonly exitExecution?: (order: PaperOrder, update: PaperPremiumUpdate, reason: Exclude<PaperPositionMonitoringResult['action'], 'NONE'>) => PaperExecutionFillSummary | undefined,
    private readonly executionEngine?: ExecutionEngineService,
    /**
     * The durable path deliberately runs before local close. It is opt-in so
     * historical/unit paths retain their existing synchronous behavior.
     */
    private readonly persistDurableExit?: (order: PaperOrder, update: PaperPremiumUpdate, reason: Exclude<PaperPositionMonitoringResult['action'], 'NONE'>, fill: PaperExecutionFillSummary) => Promise<void>,
    private readonly onDurableExitFailure?: (order: PaperOrder, error: unknown) => void | Promise<void>,
    private readonly faultInjector: ExecutionFaultInjector = noExecutionFaults,
  ) {}

  hasDurableExitPersistence(): boolean {
    return this.persistDurableExit !== undefined;
  }

  monitor(update: PaperPremiumUpdate): PaperPositionMonitoringResult[] {
    this.validateUpdate(update);
    return this.orderManager.getActiveOrders()
      .filter((order) => order.status === PaperOrderStatus.OPEN && order.contract.instrumentKey === update.instrumentKey)
      .map((order) => {
        let action: PaperPositionMonitoringResult['action'] = 'NONE';
        const timeExitAt = order.entry.entryTimestamp.getTime() + order.exitConfiguration.maximumHoldingMinutes * 60_000;
        const canClose = update.timestamp.getTime() >= order.entry.entryTimestamp.getTime();

        if (canClose && update.premium >= order.targetPremium) {
          action = PaperOrderStatus.TARGET_EXIT;
        } else if (canClose && update.premium <= order.stopPremium) {
          action = PaperOrderStatus.STOP_EXIT;
        } else if (canClose && update.timestamp.getTime() >= timeExitAt) {
          action = PaperOrderStatus.TIME_EXIT;
        }

        if (action !== 'NONE') {
          const executionFill = this.exitExecution?.(order, update, action);
          if (this.exitExecution && !executionFill) {
            return { orderId: order.id, instrumentKey: order.contract.instrumentKey, timestamp: new Date(update.timestamp.getTime()), observedPremium: update.premium, action: 'NONE', executionUnavailable: true };
          }
          this.orderManager.close(order.id, {
            exitReason: action,
            exitTimestamp: new Date(update.timestamp.getTime()),
            observedExitPremium: update.premium,
            simulatedExitPremium: executionFill?.averageFillPrice ?? update.premium,
            executionFill,
          });
          if (order.executionOrderId && executionFill) { const sessionDate = this.sessionDateFor(update.timestamp); this.executionEngine?.requestExit(order.executionOrderId, sessionDate); this.executionEngine?.recordExitFill(order.executionOrderId, sessionDate, executionFill, update.timestamp); }
          const closedOrder = this.orderManager.getById(order.id);
          if (closedOrder) this.portfolio?.close(closedOrder, this.sessionDateFor(update.timestamp));
        }

        return {
          orderId: order.id,
          instrumentKey: order.contract.instrumentKey,
          timestamp: new Date(update.timestamp.getTime()),
          observedPremium: update.premium,
          action,
        };
      });
  }

  /** Uses the established TIME_EXIT close path at the market-session boundary. */
  closeAtSessionEnd(timestamp: Date, premiumFor: (instrumentKey: string, entryPremium: number) => number | undefined): PaperPositionMonitoringResult[] {
    if (!(timestamp instanceof Date) || Number.isNaN(timestamp.getTime())) throw new Error('EOD timestamp must be valid.');
    return this.orderManager.getActiveOrders()
      .filter((order) => order.status === PaperOrderStatus.OPEN)
      .map((order) => {
        const premium = premiumFor(order.contract.instrumentKey, order.entry.observedEntryPremium);
        if (!Number.isFinite(premium) || (premium as number) <= 0) throw new Error(`No valid EOD premium is available for active paper order ${order.id}.`);
        const update = { instrumentKey: order.contract.instrumentKey, premium: premium as number, timestamp };
        const executionFill = this.exitExecution?.(order, update, PaperOrderStatus.TIME_EXIT);
        if (this.exitExecution && !executionFill) return { orderId: order.id, instrumentKey: order.contract.instrumentKey, timestamp: new Date(timestamp.getTime()), observedPremium: premium as number, action: 'NONE', executionUnavailable: true };
        this.orderManager.close(order.id, { exitReason: PaperOrderStatus.TIME_EXIT, exitTimestamp: new Date(timestamp.getTime()), observedExitPremium: premium as number, simulatedExitPremium: executionFill?.averageFillPrice ?? premium as number, executionFill });
        if (order.executionOrderId && executionFill) { const sessionDate = this.sessionDateFor(timestamp); this.executionEngine?.requestExit(order.executionOrderId, sessionDate); this.executionEngine?.recordExitFill(order.executionOrderId, sessionDate, executionFill, timestamp); }
        const closedOrder = this.orderManager.getById(order.id);
        if (closedOrder) this.portfolio?.close(closedOrder, this.sessionDateFor(timestamp));
        return { orderId: order.id, instrumentKey: order.contract.instrumentKey, timestamp: new Date(timestamp.getTime()), observedPremium: premium as number, action: PaperOrderStatus.TIME_EXIT };
      });
  }

  /**
   * Awaitable counterpart used by the live durable execution path. A local
   * observation cannot become CLOSED until the execution and portfolio
   * transaction has committed successfully.
   */
  async monitorDurably(update: PaperPremiumUpdate): Promise<PaperPositionMonitoringResult[]> {
    this.validateUpdate(update);
    if (!this.persistDurableExit) return this.monitor(update);
    const results: PaperPositionMonitoringResult[] = [];
    for (const order of this.orderManager.getActiveOrders()) {
      if (order.status !== PaperOrderStatus.OPEN || order.contract.instrumentKey !== update.instrumentKey) continue;
      const action = this.actionFor(order, update);
      if (action === 'NONE') continue;
      results.push(await this.closeDurably(order, update, action));
    }
    return results;
  }

  /** EOD uses the exact same durable exit pipeline and TIME_EXIT semantics. */
  async closeAtSessionEndDurably(timestamp: Date, premiumFor: (instrumentKey: string, entryPremium: number) => number | undefined): Promise<PaperPositionMonitoringResult[]> {
    if (!(timestamp instanceof Date) || Number.isNaN(timestamp.getTime())) throw new Error('EOD timestamp must be valid.');
    if (!this.persistDurableExit) return this.closeAtSessionEnd(timestamp, premiumFor);
    const results: PaperPositionMonitoringResult[] = [];
    for (const order of this.orderManager.getActiveOrders()) {
      if (order.status !== PaperOrderStatus.OPEN) continue;
      const premium = premiumFor(order.contract.instrumentKey, order.entry.observedEntryPremium);
      if (!Number.isFinite(premium) || (premium as number) <= 0) throw new Error(`No valid EOD premium is available for active paper order ${order.id}.`);
      results.push(await this.closeDurably(order, {
        instrumentKey: order.contract.instrumentKey,
        premium: premium as number,
        timestamp: new Date(timestamp.getTime()),
      }, PaperOrderStatus.TIME_EXIT));
    }
    return results;
  }

  private actionFor(order: PaperOrder, update: PaperPremiumUpdate): PaperPositionMonitoringResult['action'] {
    const timeExitAt = order.entry.entryTimestamp.getTime() + order.exitConfiguration.maximumHoldingMinutes * 60_000;
    const canClose = update.timestamp.getTime() >= order.entry.entryTimestamp.getTime();
    if (canClose && update.premium >= order.targetPremium) return PaperOrderStatus.TARGET_EXIT;
    if (canClose && update.premium <= order.stopPremium) return PaperOrderStatus.STOP_EXIT;
    if (canClose && update.timestamp.getTime() >= timeExitAt) return PaperOrderStatus.TIME_EXIT;
    return 'NONE';
  }

  private async closeDurably(order: PaperOrder, update: PaperPremiumUpdate, action: Exclude<PaperPositionMonitoringResult['action'], 'NONE'>): Promise<PaperPositionMonitoringResult> {
    const resultBase = { orderId: order.id, instrumentKey: order.contract.instrumentKey, timestamp: new Date(update.timestamp.getTime()), observedPremium: update.premium };
    // OPEN -> EXIT_PENDING synchronously reserves this order before any await.
    // A duplicate tick/EOD callback therefore sees a non-OPEN order and cannot
    // submit a second durable exit mutation.
    const pending = this.orderManager.requestExit(order.id);
    const executionFill = this.exitExecution?.(pending, update, action);
    if (!executionFill) {
      this.orderManager.markReconciliationRequired(order.id);
      const failed = this.orderManager.getById(order.id)!;
      await this.notifyDurableExitFailure(failed, new Error('No executable exit fill was available.'));
      return { ...resultBase, action: 'NONE', executionUnavailable: true };
    }
    if (!pending.executionOrderId) {
      this.orderManager.markReconciliationRequired(order.id);
      const failed = this.orderManager.getById(order.id)!;
      await this.notifyDurableExitFailure(failed, new Error('Durable execution order id is required for a durable exit.'));
      return { ...resultBase, action: 'NONE', executionUnavailable: true };
    }
    try {
      if (action === PaperOrderStatus.TIME_EXIT) await this.faultInjector.hit('DURING_EOD_EXIT', { executionOrderId: pending.executionOrderId ?? null, orderId: pending.id });
      await this.persistDurableExit!(pending, update, action, executionFill);
      await this.faultInjector.hit('AFTER_EXIT_DB_COMMIT_BEFORE_LOCAL_ACK', { executionOrderId: pending.executionOrderId ?? null, orderId: pending.id, exitReason: action });
      // The durable transaction has committed. Local telemetry may now become
      // CLOSED and emit its existing action/log downstream.
      this.orderManager.close(order.id, {
        exitReason: action,
        exitTimestamp: new Date(update.timestamp.getTime()),
        observedExitPremium: update.premium,
        simulatedExitPremium: executionFill.averageFillPrice,
        executionFill,
      });
      const closedOrder = this.orderManager.getById(order.id);
      if (closedOrder) this.portfolio?.close(closedOrder, this.sessionDateFor(update.timestamp));
      return { ...resultBase, action };
    } catch (error) {
      // Do not revert to OPEN: the transaction result may be uncertain after a
      // transport failure. Reconciliation owns the deterministic retry path.
      this.orderManager.markReconciliationRequired(order.id);
      const failed = this.orderManager.getById(order.id)!;
      await this.notifyDurableExitFailure(failed, error);
      return { ...resultBase, action: 'NONE', executionUnavailable: true };
    }
  }

  private async notifyDurableExitFailure(order: PaperOrder, error: unknown): Promise<void> {
    try {
      await this.onDurableExitFailure?.(order, error);
    } catch {
      // The local lifecycle is already fail-closed. A secondary audit write
      // must never re-open the order or make the market-data callback throw.
    }
  }

  private validateUpdate(update: PaperPremiumUpdate): void {
    if (!update || typeof update !== 'object') throw new Error('Paper premium update is required.');
    if (typeof update.instrumentKey !== 'string' || update.instrumentKey.trim().length === 0) throw new Error('instrumentKey must be a non-empty string.');
    if (!(update.timestamp instanceof Date) || Number.isNaN(update.timestamp.getTime())) throw new Error('timestamp must be a valid Date.');
    if (!Number.isFinite(update.premium) || update.premium < 0) throw new Error('premium must be non-negative and finite.');
  }
}

function istDate(timestamp: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(timestamp);
}
