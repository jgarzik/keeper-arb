import { type Address } from 'viem';
import { type ApiPriceProvider, type ApiPriceQuote } from './swapInterface.js';
import { oneDeltaApiProvider, sushiApiProvider } from './dex/index.js';
import { diag } from '../logging.js';

const PRICE_PROVIDERS: ApiPriceProvider[] = [
  oneDeltaApiProvider,
  sushiApiProvider,
];

export async function getBestPrice(
  chainId: number,
  tokenIn: Address,
  tokenOut: Address,
  amountIn: bigint
): Promise<ApiPriceQuote | null> {
  const providers = PRICE_PROVIDERS.filter(p => p.supportedChains.includes(chainId));
  if (providers.length === 0) {
    diag.debug('No price providers for chain', { chainId });
    return null;
  }

  const quotes = await Promise.all(
    providers.map(p => p.getPrice(chainId, tokenIn, tokenOut, amountIn))
  );

  const valid = quotes.filter((q): q is ApiPriceQuote => q !== null);
  if (valid.length === 0) {
    return null;
  }

  // Sort by amountOut descending (best price first)
  valid.sort((a, b) => (b.amountOut > a.amountOut ? 1 : b.amountOut < a.amountOut ? -1 : 0));
  return valid[0];
}
