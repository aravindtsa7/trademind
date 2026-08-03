import { Request, Response, NextFunction } from 'express';
import logger from '../../../core/logger/logger';
import { successResponse } from '../../../common/http/response';
import UpstoxService from '../services/upstox.service';

class UpstoxController {
  private service = new UpstoxService();

  async getAuthUrl(req: Request, res: Response, next: NextFunction) {
    try {
      const url = await this.service.getAuthUrl();
      return successResponse(res, { url });
    } catch (err) {
      logger.error('Failed to build Upstox auth url', { error: err });
      return next(err);
    }
  }

  async callback(req: Request, res: Response, next: NextFunction) {
    try {
      const { code } = req.query as { code?: string };
      if (!code) {
        const e: any = new Error('Missing authorization code in callback');
        e.status = 400;
        throw e;
      }

      const token = await this.service.exchangeCode(String(code));
      return successResponse(res, token);
    } catch (err) {
      logger.error('Upstox callback handling failed', { error: err });
      return next(err);
    }
  }

  async getProfile(req: Request, res: Response, next: NextFunction) {
    try {
      const authHeader = req.headers.authorization;
      const accessToken = authHeader?.startsWith('Bearer ')
        ? authHeader.slice(7)
        : (req.query.access_token as string | undefined);

      if (!accessToken) {
        const e: any = new Error('Missing access token. Provide Authorization: Bearer <token> header or access_token query param');
        e.status = 401;
        throw e;
      }

      const profile = await this.service.getProfile(accessToken);
      return successResponse(res, profile);
    } catch (err) {
      logger.error('Failed to fetch Upstox profile', { error: err });
      return next(err);
    }
  }
}

export default UpstoxController;
