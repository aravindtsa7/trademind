import { Request, Response } from 'express';
import { successResponse } from '../../../common/http/response';
import { HealthService } from '../services/health.service';

const healthService = new HealthService();

export const healthCheck = (_req: Request, res: Response) =>
  successResponse(res, healthService.getHealth());

export const readinessCheck = (_req: Request, res: Response) =>
  successResponse(res, healthService.getReadiness());
