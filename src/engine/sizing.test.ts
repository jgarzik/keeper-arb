import { describe, it, expect } from 'vitest';
import { binarySearchProfitable } from './sizing.js';

describe('binarySearchProfitable', () => {
  it('finds optimal size when all sizes are profitable', () => {
    // Profit decreases linearly from 100 at size 0 to 0 at size 100
    const profitAtSize = (size: bigint) => 100n - size;

    const result = binarySearchProfitable(profitAtSize, 10n, 100n, 0n, 1n);

    // Should find the largest size where profit > 0, which is 99
    expect(result).toBe(99n);
  });

  it('returns null when no size is profitable', () => {
    const profitAtSize = (_size: bigint) => -10n; // Always negative

    const result = binarySearchProfitable(profitAtSize, 10n, 100n, 0n, 1n);

    expect(result).toBeNull();
  });

  it('finds minimum size when only small trades are profitable', () => {
    // Only profitable below size 20
    const profitAtSize = (size: bigint) => 20n - size;

    const result = binarySearchProfitable(profitAtSize, 10n, 100n, 0n, 1n);

    expect(result).toBe(19n);
  });

  it('respects minimum profit threshold', () => {
    const profitAtSize = (size: bigint) => 100n - size;

    // Require profit > 50
    const result = binarySearchProfitable(profitAtSize, 10n, 100n, 50n, 1n);

    // Should find size where profit is just above 50, which is 49
    expect(result).toBe(49n);
  });

  it('handles constant profit function', () => {
    const profitAtSize = (_size: bigint) => 50n;

    const result = binarySearchProfitable(profitAtSize, 10n, 100n, 0n, 1n);

    // All sizes profitable, should return max
    expect(result).toBe(100n);
  });

  it('handles step function at threshold', () => {
    // Profitable only at sizes <= 50
    const profitAtSize = (size: bigint) => (size <= 50n ? 10n : -10n);

    const result = binarySearchProfitable(profitAtSize, 10n, 100n, 0n, 1n);

    expect(result).toBe(50n);
  });

  it('respects granularity by stopping search early', () => {
    // Profit is 1000 at size 0, decreasing to 0 at size 1000
    const profitAtSize = (size: bigint) => 1000n - size;

    const result = binarySearchProfitable(profitAtSize, 100n, 1000n, 0n, 100n);

    // Should find a profitable size (exact value depends on binary search path)
    expect(result).not.toBeNull();
    // Result should be between 100 and 999 (where profit > 0)
    expect(result!).toBeGreaterThanOrEqual(100n);
    expect(result!).toBeLessThan(1000n);
  });

  it('handles min > max', () => {
    const profitAtSize = (size: bigint) => 100n - size;

    const result = binarySearchProfitable(profitAtSize, 100n, 50n, 0n, 1n);

    expect(result).toBeNull();
  });

  it('handles equal min and max', () => {
    const profitAtSize = (_size: bigint) => 50n;

    const result = binarySearchProfitable(profitAtSize, 50n, 50n, 0n, 1n);

    expect(result).toBe(50n);
  });
});
