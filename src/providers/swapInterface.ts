import { type Address } from 'viem';
import { type Clients } from '../wallet.js';

export interface SwapQuote {
  provider: string;
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  amountOut: bigint;
  // For execution
  to?: Address;
  data?: `0x${string}`;
  value?: bigint;
  gasEstimate?: bigint;
}

export interface SwapProvider {
  name: string;
  chainId: number;

  // Get quote for exact input swap
  quoteExactIn(
    clients: Clients,
    tokenIn: Address,
    tokenOut: Address,
    amountIn: bigint
  ): Promise<SwapQuote | null>;

  // Execute a swap using a quote
  execute(clients: Clients, quote: SwapQuote): Promise<`0x${string}`>;
}

// Helper to find best quote from multiple providers
export async function getBestQuote(
  providers: SwapProvider[],
  clients: Clients,
  tokenIn: Address,
  tokenOut: Address,
  amountIn: bigint
): Promise<SwapQuote | null> {
  const quotes = await Promise.all(
    providers.map(async (p) => {
      try {
        return await p.quoteExactIn(clients, tokenIn, tokenOut, amountIn);
      } catch {
        return null;
      }
    })
  );

  // Filter valid quotes and find best (highest output)
  const validQuotes = quotes.filter((q): q is SwapQuote => q !== null);
  if (validQuotes.length === 0) return null;

  return validQuotes.reduce((best, q) => (q.amountOut > best.amountOut ? q : best));
}
