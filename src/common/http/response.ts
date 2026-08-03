import { Response } from 'express';

export interface ApiMeta {
  [key: string]: unknown;
}

export interface ApiSuccessPayload<T = unknown> {
  success: true;
  data: T;
  meta?: ApiMeta;
}

export interface ApiErrorPayload {
  success: false;
  message: string;
  errors?: unknown;
}

export function successResponse<T>(res: Response, data: T, statusCode = 200, meta?: ApiMeta) {
  const payload: ApiSuccessPayload<T> = {
    success: true,
    data,
  };

  if (meta) {
    payload.meta = meta;
  }

  return res.status(statusCode).json(payload);
}

export function errorResponse(res: Response, message: string, statusCode = 500, errors?: unknown) {
  const payload: ApiErrorPayload = {
    success: false,
    message,
  };

  if (errors !== undefined) {
    payload.errors = errors;
  }

  return res.status(statusCode).json(payload);
}
