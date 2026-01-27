import { type Address } from 'viem';

// API-based swap quote with pre-built transaction
export interface ApiSwapQuote {
  provider: string;
  chainId: number;
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  amountOut: bigint;
  // Pre-built tx from API
  tx: {
    to: Address;
    data: `0x${string}`;
    value: bigint;
  };
  // For approval
  spender: Address;
  priceImpact?: number;
}

// API-based swap provider interface
export interface ApiSwapProvider {
  name: string;
  supportedChains: number[];

  // Get quote with pre-built tx
  getQuote(
    chainId: number,
    tokenIn: Address,
    tokenOut: Address,
    amountIn: bigint,
    sender: Address,
    maxSlippage: number
  ): Promise<ApiSwapQuote | null>;
}
