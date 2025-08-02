import { Request, Response, NextFunction } from 'express';
import { Sentry } from '../../config/sentry';
import { logger } from '../../utils/logger';
import { ZodError } from 'zod';

export interface ApiError extends Error {
  statusCode?: number;
  isOperational?: boolean;
}

export class AppError extends Error implements ApiError {
  statusCode: number;
  isOperational: boolean;

  constructor(message: string, statusCode: number = 500) {
    super(message);
    this.statusCode = statusCode;
    this.isOperational = true;

    Error.captureStackTrace(this, this.constructor);
  }
}

export function errorHandler(
  err: ApiError,
  req: Request,
  res: Response,
  _next: NextFunction
): void {
  let statusCode = err.statusCode || 500;
  let message = err.message || 'Internal Server Error';
  let details = undefined;

  // Handle Zod validation errors
  if (err instanceof ZodError) {
    statusCode = 400;
    message = 'Validation Error';
    details = err.errors;
  }

  // Log error
  logger.error('API Error', {
    statusCode,
    message,
    url: req.url,
    method: req.method,
    ip: req.ip,
    error: err.stack,
  });

  // Send to Sentry if not operational
  if (!err.isOperational && statusCode >= 500) {
    Sentry.captureException(err, {
      extra: {
        url: req.url,
        method: req.method,
        body: req.body,
        query: req.query,
        params: req.params,
      },
    });
  }

  res.status(statusCode).json({
    success: false,
    error: {
      message,
      details,
      ...(process.env['NODE_ENV'] === 'development' && { stack: err.stack }),
    },
  });
}

export function notFoundHandler(_req: Request, res: Response): void {
  res.status(404).json({
    success: false,
    error: {
      message: 'Resource not found',
    },
  });
}