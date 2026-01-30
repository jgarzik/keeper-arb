import { type Address } from 'viem';
import { type Clients, getPublicClient } from '../wallet.js';
import { CHAIN_ID_ETHEREUM } from '../chains.js';
import { diag } from '../logging.js';
import { withRetry } from '../retry.js';
import { UNISWAP_QUOTER_V2 } from '../constants/contracts.js';

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

export interface UniswapQuote {
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  amountOut: bigint;
  feeTier: number;
}

// Get quote from Uniswap V3 on Ethereum (tries all fee tiers)
export async function getUniswapV3Quote(
  clients: Clients,
  tokenIn: Address,
  tokenOut: Address,
  amountIn: bigint
): Promise<UniswapQuote | null> {
  const publicClient = getPublicClient(clients, CHAIN_ID_ETHEREUM);

  // Try each fee tier
  for (const fee of FEE_TIERS) {
    try {
      const result = await withRetry(() =>
        publicClient.readContract({
          address: UNISWAP_QUOTER_V2,
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

      diag.debug('Uniswap V3 quote', {
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
