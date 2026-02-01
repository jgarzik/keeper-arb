import { type Address } from 'viem';
import { type Clients } from '../wallet.js';
import { CHAIN_ID_ETHEREUM } from '../chains.js';
import { diag } from '../logging.js';
import { getUniswapV3Quote } from './uniswapRef.js';
import { getBestSwapQuote } from './swapAggregator.js';

export interface RefPrice {
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  amountOut: bigint;
  source: string;
}

// Get best reference price from multiple sources (Uniswap V3 + aggregators)
export async function getEthRefPrice(
  clients: Clients,
  tokenIn: Address,
  tokenOut: Address,
  amountIn: bigint,
  srcDecimals: number,
  destDecimals: number
): Promise<RefPrice | null> {
  // Query both sources in parallel
  const [uniQuote, aggQuote] = await Promise.all([
    getUniswapV3Quote(clients, tokenIn, tokenOut, amountIn),
    getBestSwapQuote(clients, CHAIN_ID_ETHEREUM, tokenIn, tokenOut, amountIn, undefined, srcDecimals, destDecimals),
  ]);

  // Pick the quote that gives MORE tokens (better price)
  // Aggregators often find better routes through intermediate tokens
  let best: RefPrice | null = null;

  if (uniQuote && aggQuote) {
    if (aggQuote.amountOut >= uniQuote.amountOut) {
      best = {
        tokenIn,
        tokenOut,
        amountIn,
        amountOut: aggQuote.amountOut,
        source: `aggregator:${aggQuote.provider}`,
      };
    } else {
      best = {
        tokenIn,
        tokenOut,
        amountIn,
        amountOut: uniQuote.amountOut,
        source: `uniswap-v3:fee=${uniQuote.feeTier}`,
      };
    }
  } else if (aggQuote) {
    best = {
      tokenIn,
      tokenOut,
      amountIn,
      amountOut: aggQuote.amountOut,
      source: `aggregator:${aggQuote.provider}`,
    };
  } else if (uniQuote) {
    best = {
      tokenIn,
      tokenOut,
      amountIn,
      amountOut: uniQuote.amountOut,
      source: `uniswap-v3:fee=${uniQuote.feeTier}`,
    };
  }

  if (best) {
    diag.debug('Eth ref price', {
      source: best.source,
      tokenIn,
      tokenOut,
      amountIn: amountIn.toString(),
      amountOut: best.amountOut.toString(),
      uniOut: uniQuote?.amountOut.toString() || 'none',
      aggOut: aggQuote?.amountOut.toString() || 'none',
    });
    return best;
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
