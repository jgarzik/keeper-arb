import { describe, it, expect } from 'vitest';
import { formatVcred, formatEth } from './accounting.js';

describe('formatVcred', () => {
  it('formats whole number correctly', () => {
    const amount = 1000n * 10n ** 18n;
    expect(formatVcred(amount)).toBe('1000.0000');
  });

  it('formats fractional amount correctly', () => {
    const amount = 1234567890123456789012n; // 1234.567890123456789012
    expect(formatVcred(amount)).toBe('1234.5678');
  });

  it('formats zero correctly', () => {
    expect(formatVcred(0n)).toBe('0.0000');
  });

  it('formats small amount correctly', () => {
    const amount = 10n ** 14n; // 0.0001
    expect(formatVcred(amount)).toBe('0.0001');
  });

  it('formats very small amount correctly', () => {
    const amount = 10n ** 10n; // 0.00000001
    expect(formatVcred(amount)).toBe('0.0000');
  });

  it('formats large amount correctly', () => {
    const amount = 1000000n * 10n ** 18n; // 1 million
    expect(formatVcred(amount)).toBe('1000000.0000');
  });
});

describe('formatEth', () => {
  it('formats whole ETH correctly', () => {
    const amount = 10n ** 18n;
    expect(formatEth(amount)).toBe('1.000000');
  });

  it('formats fractional ETH correctly', () => {
    const amount = 1234567890000000000n; // 1.23456789
    expect(formatEth(amount)).toBe('1.234567');
  });

  it('formats zero correctly', () => {
    expect(formatEth(0n)).toBe('0.000000');
  });

  it('formats gwei correctly', () => {
    const amount = 10n ** 9n; // 1 gwei = 0.000000001 ETH
    expect(formatEth(amount)).toBe('0.000000');
  });

  it('formats common gas costs correctly', () => {
    // Typical gas cost: 0.01 ETH
    const amount = 10n ** 16n;
    expect(formatEth(amount)).toBe('0.010000');
  });

  it('formats large ETH amounts correctly', () => {
    const amount = 100n * 10n ** 18n;
    expect(formatEth(amount)).toBe('100.000000');
  });
});
