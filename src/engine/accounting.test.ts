import { describe, it, expect } from 'vitest';
import { formatToken, formatVcred, formatEth } from './accounting.js';

describe('formatToken', () => {
  it('formats 6 decimal token correctly', () => {
    const amount = 1000n * 10n ** 6n;
    expect(formatToken(amount, 6, 4)).toBe('1000.0000');
  });

  it('formats 18 decimal token correctly', () => {
    const amount = 1000n * 10n ** 18n;
    expect(formatToken(amount, 18, 6)).toBe('1000.000000');
  });

  it('formats fractional amounts correctly', () => {
    const amount = 1234567890n; // 1234.567890 (6 decimals)
    expect(formatToken(amount, 6, 4)).toBe('1234.5678');
  });

  it('formats zero correctly', () => {
    expect(formatToken(0n, 6, 4)).toBe('0.0000');
    expect(formatToken(0n, 18, 6)).toBe('0.000000');
  });

  it('formats small amounts correctly', () => {
    const amount = 10n ** 2n; // 0.0001 (6 decimals)
    expect(formatToken(amount, 6, 4)).toBe('0.0001');
  });

  it('formats very small amounts correctly', () => {
    const amount = 1n; // Very small
    expect(formatToken(amount, 6, 4)).toBe('0.0000');
  });

  it('formats large amounts correctly', () => {
    const amount = 1000000n * 10n ** 6n;
    expect(formatToken(amount, 6, 4)).toBe('1000000.0000');
  });

  it('handles 8 decimal tokens (BTC)', () => {
    const amount = 12345678n; // 0.12345678 BTC
    expect(formatToken(amount, 8, 6)).toBe('0.123456');
  });
});

describe('formatVcred (legacy)', () => {
  it('formats VCRED correctly', () => {
    const amount = 1000n * 10n ** 6n;
    expect(formatVcred(amount)).toBe('1000.0000');
  });
});

describe('formatEth (legacy)', () => {
  it('formats ETH correctly', () => {
    const amount = 10n ** 18n;
    expect(formatEth(amount)).toBe('1.000000');
  });
});
