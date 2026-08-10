import { PaperOrder, PaperOrderExit, PaperOrderStatus } from '../types/paper-trading.types';

/** In-memory lifecycle boundary for simulated option orders. */
export interface PaperOrderManager {
  create(order: Omit<PaperOrder, 'id' | 'status' | 'targetPremium' | 'stopPremium' | 'exit'>): PaperOrder;
  markOpen(id: string): PaperOrder;
  getById(id: string): PaperOrder | undefined;
  getActiveOrders(): PaperOrder[];
  updateStatus(id: string, status: PaperOrderStatus): PaperOrder;
  close(id: string, exit: PaperOrderExit): PaperOrder;
}

