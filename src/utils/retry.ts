import { logger } from './logger';

export interface RetryOptions {
  maxAttempts?: number;
  delay?: number;
  multiplier?: number;
  maxDelay?: number;
  onRetry?: (error: Error, attempt: number) => void;
}

export async function retry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const {
    maxAttempts = 3,
    delay = 1000,
    multiplier = 2,
    maxDelay = 30000,
    onRetry,
  } = options;

  let lastError: Error;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;

      if (attempt === maxAttempts) {
        throw lastError;
      }

      const backoffDelay = Math.min(
        delay * Math.pow(multiplier, attempt - 1),
        maxDelay
      );

      logger.warn(`Retry attempt ${attempt}/${maxAttempts} after ${backoffDelay}ms`, {
        error: lastError.message,
      });

      if (onRetry) {
        onRetry(lastError, attempt);
      }

      await new Promise((resolve) => setTimeout(resolve, backoffDelay));
    }
  }

  throw lastError!;
}