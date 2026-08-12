import PaperOrderManagerService from './paper-order-manager.service';
import {
  PaperOrderStatus,
  PaperPositionMonitoringResult,
  PaperPremiumUpdate,
} from '../types/paper-trading.types';

/**
 * Evaluates observed live premiums for existing OPEN paper orders. It owns no
 * market connection and intentionally leaves slippage, charges, and P&L unset.
 */
export default class PaperPositionMonitorService {
  constructor(private readonly orderManager: PaperOrderManagerService) {}

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
          this.orderManager.close(order.id, {
            exitReason: action,
            exitTimestamp: new Date(update.timestamp.getTime()),
            observedExitPremium: update.premium,
            simulatedExitPremium: update.premium,
          });
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
        this.orderManager.close(order.id, { exitReason: PaperOrderStatus.TIME_EXIT, exitTimestamp: new Date(timestamp.getTime()), observedExitPremium: premium as number, simulatedExitPremium: premium as number });
        return { orderId: order.id, instrumentKey: order.contract.instrumentKey, timestamp: new Date(timestamp.getTime()), observedPremium: premium as number, action: PaperOrderStatus.TIME_EXIT };
      });
  }

  private validateUpdate(update: PaperPremiumUpdate): void {
    if (!update || typeof update !== 'object') throw new Error('Paper premium update is required.');
    if (typeof update.instrumentKey !== 'string' || update.instrumentKey.trim().length === 0) throw new Error('instrumentKey must be a non-empty string.');
    if (!(update.timestamp instanceof Date) || Number.isNaN(update.timestamp.getTime())) throw new Error('timestamp must be a valid Date.');
    if (!Number.isFinite(update.premium) || update.premium < 0) throw new Error('premium must be non-negative and finite.');
  }
}
