import { NextFunction, Request, Response } from 'express';
import { successResponse } from '../../../common/http/response';
import logger from '../../../core/logger/logger';
import InstrumentSyncService from '../services/instrument-sync.service';

export default class InstrumentSyncController {
  private service = new InstrumentSyncService();

  async sync(_req: Request, res: Response, next: NextFunction) {
    try {
      const summary = await this.service.sync();
      return successResponse(res, summary);
    } catch (error) {
      logger.error('Instrument sync request failed', { error });
      return next(error);
    }
  }
}
