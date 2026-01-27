import { diag } from './logging.js';

export interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  shouldRetry?: (error: unknown) => boolean;
}

/**
 * Check if an error is likely transient and worth retrying
 */
export function isTransientError(error: unknown): boolean {
  const msg = String(error).toLowerCase();
  return (
    msg.includes('timeout') ||
    msg.includes('econnrefused') ||
    msg.includes('econnreset') ||
    msg.includes('etimedout') ||
    msg.includes('rate limit') ||
    msg.includes('429') ||
    msg.includes('503') ||
    msg.includes('502') ||
    msg.includes('504') ||
    msg.includes('network') ||
    msg.includes('socket hang up')
  );
}

/**
 * Execute a function with exponential backoff retry on transient errors
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const {
    maxRetries = 3,
    baseDelayMs = 1000,
    maxDelayMs = 30000,
    shouldRetry = isTransientError,
  } = options;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const isLastAttempt = attempt === maxRetries;
      const isRetryable = shouldRetry(error);

      if (isLastAttempt || !isRetryable) {
        throw error;
      }

      const delay = Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
      diag.warn('Retrying after transient error', {
        attempt: attempt + 1,
        maxRetries,
        delayMs: delay,
        error: String(error),
      });

      await new Promise((r) => setTimeout(r, delay));
    }
  }

  // Unreachable but TypeScript needs this
  throw new Error('Retry loop exited unexpectedly');
}
