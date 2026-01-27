import { type Address } from 'viem';

// Health check result for a provider
export interface ProviderHealth {
  provider: string;
  status: 'ok' | 'degraded' | 'error';
  latencyMs: number;
  error?: string;
  details?: Record<string, unknown>;
}

// Price-only quote (no tx calldata)
export interface ApiPriceQuote {
  provider: string;
  chainId: number;
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  amountOut: bigint;
}

// API-based price provider interface
export interface ApiPriceProvider {
  name: string;
  supportedChains: number[];
  getPrice(
    chainId: number,
    tokenIn: Address,
    tokenOut: Address,
    amountIn: bigint
  ): Promise<ApiPriceQuote | null>;
}

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

  // Optional health check
  checkHealth?(): Promise<ProviderHealth>;
}
