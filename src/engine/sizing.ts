import { type Clients } from '../wallet.js';
import { type Config } from '../config.js';
import { type TokenId, requireTokenDecimals } from '../tokens.js';
import { CHAIN_ID_HEMI } from '../chains.js';
import { estimateProfit, type ProfitEstimate } from './profit.js';
import { diag } from '../logging.js';

export interface SizingResult {
  token: TokenId;
  optimalVcredIn: bigint;
  estimatedProfit: bigint;
  profitEstimate: ProfitEstimate;
}

const MAX_QUOTE_CALLS = 15; // Limit quote calls per sizing operation

// Binary search to find maximum profitable trade size
export async function findOptimalSize(
  clients: Clients,
  config: Config,
  token: TokenId,
  availableVcred: bigint
): Promise<SizingResult | null> {
  const minSize = config.minSwapVcred;
  const maxSize = availableVcred < config.maxSwapVcredCap ? availableVcred : config.maxSwapVcredCap;

  if (maxSize < minSize) {
    diag.debug('Insufficient VCRED for trade', {
      available: availableVcred.toString(),
      minRequired: minSize.toString(),
    });
    return null;
  }

  let quoteCalls = 0;

  // Helper to check profitability at a given size
  async function isProfitable(vcredIn: bigint): Promise<ProfitEstimate | null> {
    if (quoteCalls >= MAX_QUOTE_CALLS) {
      return null;
    }
    quoteCalls++;

    try {
      return await estimateProfit(clients, config, token, vcredIn);
    } catch {
      return null;
    }
  }

  // Start with default test size (1000 VCRED using correct decimals)
  const vcredDecimals = requireTokenDecimals('VCRED', CHAIN_ID_HEMI);
  let testSize = 1000n * (10n ** BigInt(vcredDecimals));
  if (testSize > maxSize) testSize = maxSize;
  if (testSize < minSize) testSize = minSize;

  const initialProfit = await isProfitable(testSize);
  if (!initialProfit) {
    diag.debug('Could not get initial profit estimate', { token, testSize: testSize.toString() });
    return null;
  }

  if (initialProfit.netProfitVcred <= config.minProfitVcred) {
    // Not profitable at base size, try shrinking
    let lower = minSize;
    let upper = testSize;
    const granularity = 10n ** BigInt(vcredDecimals);

    while (upper - lower > granularity && quoteCalls < MAX_QUOTE_CALLS) {
      const mid = (lower + upper) / 2n;
      const profit = await isProfitable(mid);

      if (profit && profit.netProfitVcred > config.minProfitVcred) {
        // Found profitable size, search upward
        lower = mid;
      } else {
        // Still not profitable, search lower
        upper = mid;
      }
    }

    const finalProfit = await isProfitable(lower);
    if (!finalProfit || finalProfit.netProfitVcred <= config.minProfitVcred) {
      diag.info('No profitable size found', { token });
      return null;
    }

    return {
      token,
      optimalVcredIn: lower,
      estimatedProfit: finalProfit.netProfitVcred,
      profitEstimate: finalProfit,
    };
  }

  // Profitable at base size, try to find maximum profitable size
  let good = testSize;
  let goodProfit = initialProfit;
  let bad = maxSize;

  // First, expand to find upper bound
  while (good < maxSize && quoteCalls < MAX_QUOTE_CALLS) {
    const next = good * 2n > maxSize ? maxSize : good * 2n;
    const profit = await isProfitable(next);

    if (profit && profit.netProfitVcred > config.minProfitVcred) {
      good = next;
      goodProfit = profit;
    } else {
      bad = next;
      break;
    }
  }

  // Binary search between good and bad
  const granularity = 10n ** BigInt(vcredDecimals);
  while (bad - good > granularity && quoteCalls < MAX_QUOTE_CALLS) {
    const mid = (good + bad) / 2n;
    const profit = await isProfitable(mid);

    if (profit && profit.netProfitVcred > config.minProfitVcred) {
      good = mid;
      goodProfit = profit;
    } else {
      bad = mid;
    }
  }

  diag.info('Optimal size found', {
    token,
    vcredIn: good.toString(),
    profit: goodProfit.netProfitVcred.toString(),
    quoteCalls,
  });

  return {
    token,
    optimalVcredIn: good,
    estimatedProfit: goodProfit.netProfitVcred,
    profitEstimate: goodProfit,
  };
}

// Pure binary search logic for testing
export function binarySearchProfitable(
  profitAtSize: (size: bigint) => bigint, // Returns profit for a given size
  minSize: bigint,
  maxSize: bigint,
  minProfit: bigint,
  granularity: bigint = 1n
): bigint | null {
  if (maxSize < minSize) return null;

  // Check if any size is profitable
  if (profitAtSize(minSize) <= minProfit) {
    // Even minimum size isn't profitable
    return null;
  }

  let good = minSize;
  let bad = maxSize + granularity;

  // Binary search
  while (bad - good > granularity) {
    const mid = (good + bad) / 2n;
    if (profitAtSize(mid) > minProfit) {
      good = mid;
    } else {
      bad = mid;
    }
  }

  return good;
}
