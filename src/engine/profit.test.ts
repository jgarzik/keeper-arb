import { describe, it, expect } from 'vitest';
import { calculateNetProfit, convertFeeToVcred } from './profit.js';

describe('calculateNetProfit', () => {
  it('calculates positive profit correctly', () => {
    const vcredIn = 1000n * 10n ** 18n;  // 1000 VCRED
    const vcredOut = 1050n * 10n ** 18n; // 1050 VCRED
    const fees = 10n * 10n ** 18n;       // 10 VCRED

    const profit = calculateNetProfit(vcredIn, vcredOut, fees);

    expect(profit).toBe(40n * 10n ** 18n); // 1050 - 1000 - 10 = 40
  });

  it('calculates negative profit (loss) correctly', () => {
    const vcredIn = 1000n * 10n ** 18n;
    const vcredOut = 980n * 10n ** 18n;
    const fees = 10n * 10n ** 18n;

    const profit = calculateNetProfit(vcredIn, vcredOut, fees);

    expect(profit).toBe(-30n * 10n ** 18n); // 980 - 1000 - 10 = -30
  });

  it('handles zero fees', () => {
    const vcredIn = 1000n * 10n ** 18n;
    const vcredOut = 1100n * 10n ** 18n;
    const fees = 0n;

    const profit = calculateNetProfit(vcredIn, vcredOut, fees);

    expect(profit).toBe(100n * 10n ** 18n);
  });

  it('handles break-even scenario', () => {
    const vcredIn = 1000n * 10n ** 18n;
    const vcredOut = 1010n * 10n ** 18n;
    const fees = 10n * 10n ** 18n;

    const profit = calculateNetProfit(vcredIn, vcredOut, fees);

    expect(profit).toBe(0n);
  });

  it('handles very small amounts', () => {
    const vcredIn = 100n; // 0.0000000000000001 VCRED
    const vcredOut = 110n;
    const fees = 5n;

    const profit = calculateNetProfit(vcredIn, vcredOut, fees);

    expect(profit).toBe(5n);
  });

  it('handles very large amounts', () => {
    const vcredIn = 10n ** 30n; // Very large
    const vcredOut = 10n ** 30n + 10n ** 28n;
    const fees = 10n ** 27n;

    const profit = calculateNetProfit(vcredIn, vcredOut, fees);

    expect(profit).toBe(10n ** 28n - 10n ** 27n);
  });
});

describe('convertFeeToVcred', () => {
  it('converts ETH fee to VCRED correctly', () => {
    const feeEth = 10n ** 16n; // 0.01 ETH
    const ethToVcredRate = 2000n * 10n ** 18n; // 1 ETH = 2000 VCRED

    const feeVcred = convertFeeToVcred(feeEth, ethToVcredRate);

    // 0.01 ETH * 2000 VCRED/ETH = 20 VCRED
    expect(feeVcred).toBe(20n * 10n ** 18n);
  });

  it('handles zero fee', () => {
    const feeEth = 0n;
    const ethToVcredRate = 2000n * 10n ** 18n;

    const feeVcred = convertFeeToVcred(feeEth, ethToVcredRate);

    expect(feeVcred).toBe(0n);
  });

  it('handles very small fees', () => {
    const feeEth = 1000n; // Very small amount of gwei
    const ethToVcredRate = 2000n * 10n ** 18n;

    const feeVcred = convertFeeToVcred(feeEth, ethToVcredRate);

    // Should round down due to integer division
    expect(feeVcred).toBe(2000000n);
  });

  it('handles different exchange rates', () => {
    const feeEth = 10n ** 17n; // 0.1 ETH

    // Low rate
    const lowRate = 100n * 10n ** 18n; // 1 ETH = 100 VCRED
    expect(convertFeeToVcred(feeEth, lowRate)).toBe(10n * 10n ** 18n);

    // High rate
    const highRate = 10000n * 10n ** 18n; // 1 ETH = 10000 VCRED
    expect(convertFeeToVcred(feeEth, highRate)).toBe(1000n * 10n ** 18n);
  });
});
