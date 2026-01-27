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

// Get reference price from Uniswap V3 on Ethereum
export async function getUniswapRefPrice(
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

  diag.warn('No Uniswap pool found', { tokenIn, tokenOut });
  return null;
}

// Compare Hemi price vs Ethereum reference
// Returns discount percentage (positive = cheaper on Hemi)
export function calculateDiscount(
  hemiAmountOut: bigint,
  ethRefAmountOut: bigint
): number {
  if (ethRefAmountOut === 0n) return 0;

  // If hemiAmountOut > ethRefAmountOut, we're getting more on Hemi = discount
  const diff = hemiAmountOut - ethRefAmountOut;
  return Number((diff * 10000n) / ethRefAmountOut) / 100; // percentage with 2 decimals
}
