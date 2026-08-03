import { NextFunction, Request, Response } from 'express';
import logger from '../core/logger/logger';
import { errorResponse } from '../common/http/response';

interface HttpError extends Error {
  status?: number;
  errors?: unknown;
}

export function errorHandler(err: HttpError, req: Request, res: Response, _next: NextFunction) {
  const statusCode = err.status ?? 500;
  const message = err.message || 'Internal Server Error';

  logger.error('Unhandled error occurred', {
    message,
    statusCode,
    path: req.path,
    method: req.method,
    errors: err.errors,
    stack: err.stack,
  });

  return errorResponse(res, message, statusCode, err.errors);
}
