import { Request, Response, NextFunction } from 'express';
import { errorResponse } from '../common/http/response';

export function notFoundHandler(req: Request, res: Response, _next: NextFunction) {
  return errorResponse(res, 'Route not found', 404);
}
