import { type Address } from 'viem';
import { type Clients, getPublicClient } from '../wallet.js';
import { CHAIN_ID_ETHEREUM } from '../chains.js';
import { diag } from '../logging.js';
import { withRetry } from '../retry.js';

// Uniswap V3 Quoter V2 on Ethereum
const QUOTER_V2_ADDRESS: Address = '0x61fFE014bA17989E743c5F6cB21bF9697530B21e';

const QUOTER_ABI = [
  {
    name: 'quoteExactInputSingle',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'params',
        type: 'tuple',
        components: [
          { name: 'tokenIn', type: 'address' },
          { name: 'tokenOut', type: 'address' },
          { name: 'amountIn', type: 'uint256' },
          { name: 'fee', type: 'uint24' },
          { name: 'sqrtPriceLimitX96', type: 'uint160' },
        ],
      },
    ],
    outputs: [
      { name: 'amountOut', type: 'uint256' },
      { name: 'sqrtPriceX96After', type: 'uint160' },
      { name: 'initializedTicksCrossed', type: 'uint32' },
      { name: 'gasEstimate', type: 'uint256' },
    ],
  },
] as const;

// Common fee tiers to try
const FEE_TIERS = [500, 3000, 10000] as const; // 0.05%, 0.3%, 1%

export interface RefPrice {
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  amountOut: bigint;
  feeTier: number;
}

// Get reference price from Uniswap V3 on Ethereum (internal)
async function getUniswapV3Price(
  clients: Clients,
  tokenIn: Address,
  tokenOut: Address,
  amountIn: bigint
): Promise<RefPrice | null> {
  const publicClient = getPublicClient(clients, CHAIN_ID_ETHEREUM);

  // Try each fee tier
  for (const fee of FEE_TIERS) {
    try {
      const result = await withRetry(() =>
        publicClient.readContract({
          address: QUOTER_V2_ADDRESS,
          abi: QUOTER_ABI,
          functionName: 'quoteExactInputSingle',
          args: [
            {
              tokenIn,
              tokenOut,
              amountIn,
              fee,
              sqrtPriceLimitX96: 0n,
            },
          ],
        })
      ) as readonly [bigint, bigint, number, bigint];

      const amountOut = result[0];

      diag.debug('Uniswap ref price', {
        tokenIn,
        tokenOut,
        amountIn: amountIn.toString(),
        amountOut: amountOut.toString(),
        feeTier: fee,
      });

      return {
        tokenIn,
        tokenOut,
        amountIn,
        amountOut,
        feeTier: fee,
      };
    } catch {
      // Try next fee tier
      continue;
    }
  }

  return null;
}

// Get reference price - try Uniswap V3 first, then fall back to aggregator
export async function getUniswapRefPrice(
  clients: Clients,
  tokenIn: Address,
  tokenOut: Address,
  amountIn: bigint
): Promise<RefPrice | null> {
  // Dynamic import to avoid circular dependency
  const { getBestSwapQuote } = await import('./swapAggregator.js');

  // Try Uniswap V3 first (fastest, no API calls)
  const uniPrice = await getUniswapV3Price(clients, tokenIn, tokenOut, amountIn);
  if (uniPrice) {
    return uniPrice;
  }

  // Fall back to aggregator (SushiSwap, 0x, etc.)
  diag.debug('No Uniswap pool, trying aggregator', { tokenIn, tokenOut });
  const aggQuote = await getBestSwapQuote(
    clients,
    CHAIN_ID_ETHEREUM,
    tokenIn,
    tokenOut,
    amountIn
  );

  if (aggQuote) {
    diag.debug('Aggregator ref price', {
      provider: aggQuote.provider,
      tokenIn,
      tokenOut,
      amountIn: amountIn.toString(),
      amountOut: aggQuote.amountOut.toString(),
    });

    return {
      tokenIn,
      tokenOut,
      amountIn,
      amountOut: aggQuote.amountOut,
      feeTier: 0, // Not applicable for aggregator
    };
  }

  diag.warn('No ref price from any source', { tokenIn, tokenOut });
  return null;
}

// Compare Hemi price vs Ethereum reference
// Returns discount in basis points as bigint (positive = cheaper on Hemi)
export function calculateDiscountBps(
  hemiAmountOut: bigint,
  ethRefAmountOut: bigint
): bigint {
  if (ethRefAmountOut === 0n) return 0n;

  // If hemiAmountOut > ethRefAmountOut, we're getting more on Hemi = discount
  return ((hemiAmountOut - ethRefAmountOut) * 10000n) / ethRefAmountOut;
}

// Format basis points as percentage string (e.g., 150n -> "1.50%")
export function formatDiscountPercent(bps: bigint): string {
  const sign = bps < 0n ? '-' : '';
  const absBps = bps < 0n ? -bps : bps;
  const whole = absBps / 100n;
  const frac = (absBps % 100n).toString().padStart(2, '0');
  return `${sign}${whole}.${frac}%`;
}

// Legacy wrapper for callers that need a number (for sorting/comparison)
// Safe for values that fit in JS number precision (< 2^53 basis points)
export function calculateDiscount(
  hemiAmountOut: bigint,
  ethRefAmountOut: bigint
): number {
  const bps = calculateDiscountBps(hemiAmountOut, ethRefAmountOut);
  return Number(bps) / 100; // percentage with 2 decimals
}
