import { Request, Response } from 'express';
import { successResponse } from '../http/response';

export const healthCheck = (_req: Request, res: Response) =>
  successResponse(res, {
    status: 'ok',
    timestamp: new Date().toISOString(),
  });

export const readinessCheck = (_req: Request, res: Response) =>
  successResponse(res, {
    status: 'ready',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
