import { NextFunction, Request, Response } from 'express';
import { successResponse } from '../../../common/http/response';
import logger from '../../../core/logger/logger';
import HistoricalCandleSyncService from '../services/historical-candle-sync.service';

export default class HistoricalCandleController {
  private service = new HistoricalCandleSyncService();

  async sync(req: Request, res: Response, next: NextFunction) {
    try {
      const { instrumentKey, fromDate, toDate, tradingDates } = req.body as {
        instrumentKey: string;
        fromDate: string;
        toDate: string;
        tradingDates?: string[];
      };
      const summary = await this.service.sync(
        instrumentKey,
        fromDate,
        toDate,
        tradingDates && tradingDates.length > 0 ? { tradingDates } : undefined
      );

      return successResponse(res, summary);
    } catch (error) {
      logger.error('Historical candle sync request failed', { error });
      return next(error);
    }
  }
}
