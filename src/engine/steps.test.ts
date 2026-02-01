import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { isQuoteStale } from './steps.js';
import { isTransientError } from '../retry.js';
import { type ApiSwapQuote } from '../providers/swapInterface.js';
import { MAX_QUOTE_AGE_MS } from '../constants/timing.js';

// Helper to create a mock quote with a specific timestamp
function createMockQuote(quotedAt: number): ApiSwapQuote {
  return {
    provider: 'test',
    chainId: 1,
    tokenIn: '0x0000000000000000000000000000000000000001',
    tokenOut: '0x0000000000000000000000000000000000000002',
    amountIn: 1000n,
    amountOut: 900n,
    tx: {
      to: '0x0000000000000000000000000000000000000003',
      data: '0x1234',
      value: 0n,
    },
    spender: '0x0000000000000000000000000000000000000003',
    quotedAt,
  };
}

describe('isQuoteStale', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns false for a fresh quote', () => {
    const now = Date.now();
    vi.setSystemTime(now);
    const quote = createMockQuote(now);

    expect(isQuoteStale(quote)).toBe(false);
  });

  it('returns false for a quote at exactly max age', () => {
    const now = Date.now();
    vi.setSystemTime(now);
    const quote = createMockQuote(now - MAX_QUOTE_AGE_MS);

    expect(isQuoteStale(quote)).toBe(false);
  });

  it('returns true for a quote older than max age', () => {
    const now = Date.now();
    vi.setSystemTime(now);
    const quote = createMockQuote(now - MAX_QUOTE_AGE_MS - 1);

    expect(isQuoteStale(quote)).toBe(true);
  });

  it('returns true for a very old quote', () => {
    const now = Date.now();
    vi.setSystemTime(now);
    const quote = createMockQuote(now - 60_000); // 1 minute old

    expect(isQuoteStale(quote)).toBe(true);
  });

  it('respects custom maxAge parameter', () => {
    const now = Date.now();
    vi.setSystemTime(now);
    const quote = createMockQuote(now - 5_000); // 5 seconds old

    // With default 30s max age, should be fresh
    expect(isQuoteStale(quote)).toBe(false);

    // With 3s max age, should be stale
    expect(isQuoteStale(quote, 3_000)).toBe(true);
  });

  it('handles quote with quotedAt of 0 (force re-quote)', () => {
    const now = Date.now();
    vi.setSystemTime(now);
    const quote = createMockQuote(0);

    expect(isQuoteStale(quote)).toBe(true);
  });
});

describe('isTransientError', () => {
  it('identifies timeout errors as transient', () => {
    expect(isTransientError(new Error('Request timeout'))).toBe(true);
    expect(isTransientError(new Error('ETIMEDOUT'))).toBe(true);
  });

  it('identifies connection errors as transient', () => {
    expect(isTransientError(new Error('ECONNREFUSED'))).toBe(true);
    expect(isTransientError(new Error('ECONNRESET'))).toBe(true);
    expect(isTransientError(new Error('socket hang up'))).toBe(true);
  });

  it('identifies rate limit errors as transient', () => {
    expect(isTransientError(new Error('rate limit exceeded'))).toBe(true);
    expect(isTransientError(new Error('429 Too Many Requests'))).toBe(true);
  });

  it('identifies server errors as transient', () => {
    expect(isTransientError(new Error('502 Bad Gateway'))).toBe(true);
    expect(isTransientError(new Error('503 Service Unavailable'))).toBe(true);
    expect(isTransientError(new Error('504 Gateway Timeout'))).toBe(true);
  });

  it('identifies network errors as transient', () => {
    expect(isTransientError(new Error('Network error'))).toBe(true);
  });

  it('identifies simulation failures as transient', () => {
    expect(isTransientError(new Error('Swap simulation failed: reverted'))).toBe(true);
    expect(isTransientError(new Error('simulation failed'))).toBe(true);
  });

  it('does not identify permanent errors as transient', () => {
    expect(isTransientError(new Error('Insufficient balance'))).toBe(false);
    expect(isTransientError(new Error('Invalid address'))).toBe(false);
    expect(isTransientError(new Error('Execution reverted'))).toBe(false);
    expect(isTransientError(new Error('User rejected transaction'))).toBe(false);
  });

  it('handles non-Error objects', () => {
    expect(isTransientError('timeout')).toBe(true);
    expect(isTransientError({ message: 'timeout' })).toBe(false); // toString gives [object Object]
    expect(isTransientError(null)).toBe(false);
    expect(isTransientError(undefined)).toBe(false);
  });
});
