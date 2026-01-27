import { type Address } from 'viem';
import { type ApiSwapProvider, type ApiSwapQuote } from '../swapInterface.js';
import { CHAIN_ID_ETHEREUM } from '../../chains.js';
import { diag } from '../../logging.js';
import { withRetry } from '../../retry.js';

/**
 * 0x/Matcha API provider - aggregates liquidity from Curve, Uniswap, Balancer, etc.
 * Docs: https://0x.org/docs/api
 */
const ZERO_X_API_BASE = 'https://api.0x.org/swap/v1';

interface ZeroXQuoteResponse {
  sellAmount: string;
  buyAmount: string;
  to: string;
  data: string;
  value: string;
  allowanceTarget: string;
  estimatedPriceImpact?: string;
  sources?: Array<{ name: string; proportion: string }>;
}

class ZeroXApiProvider implements ApiSwapProvider {
  readonly name = '0x-api';
  readonly supportedChains = [CHAIN_ID_ETHEREUM];

  async getQuote(
    chainId: number,
    tokenIn: Address,
    tokenOut: Address,
    amountIn: bigint,
    sender: Address,
    maxSlippage: number
  ): Promise<ApiSwapQuote | null> {
    if (!this.supportedChains.includes(chainId)) {
      return null;
    }

    const url = new URL(`${ZERO_X_API_BASE}/quote`);
    url.searchParams.set('sellToken', tokenIn);
    url.searchParams.set('buyToken', tokenOut);
    url.searchParams.set('sellAmount', amountIn.toString());
    url.searchParams.set('slippagePercentage', maxSlippage.toString());
    url.searchParams.set('takerAddress', sender);
    url.searchParams.set('skipValidation', 'true');

    try {
      const response = await withRetry(async () => {
        const res = await fetch(url.toString(), {
          headers: {
            Accept: 'application/json',
            '0x-api-key': process.env.ZERO_X_API_KEY || '',
          },
        });
        if (!res.ok) {
          const text = await res.text();
          throw new Error(`0x API HTTP ${res.status}: ${text}`);
        }
        return res.json() as Promise<ZeroXQuoteResponse>;
      });

      if (!response.buyAmount || !response.to || !response.data) {
        diag.debug('0x API incomplete response', { chainId, tokenIn, tokenOut });
        return null;
      }

      const quote: ApiSwapQuote = {
        provider: this.name,
        chainId,
        tokenIn,
        tokenOut,
        amountIn,
        amountOut: BigInt(response.buyAmount),
        tx: {
          to: response.to as Address,
          data: response.data as `0x${string}`,
          value: BigInt(response.value || '0'),
        },
        spender: response.allowanceTarget as Address,
        priceImpact: response.estimatedPriceImpact
          ? parseFloat(response.estimatedPriceImpact)
          : undefined,
      };

      // Log which sources contributed (Curve, Uniswap, etc.)
      const sources = response.sources
        ?.filter((s) => parseFloat(s.proportion) > 0)
        .map((s) => `${s.name}:${(parseFloat(s.proportion) * 100).toFixed(0)}%`)
        .join(', ');

      diag.debug('0x API quote', {
        chainId,
        tokenIn,
        tokenOut,
        amountIn: amountIn.toString(),
        amountOut: quote.amountOut.toString(),
        priceImpact: quote.priceImpact,
        sources,
      });

      return quote;
    } catch (err) {
      diag.warn('0x API error', {
        chainId,
        tokenIn,
        tokenOut,
        error: String(err),
      });
      return null;
    }
  }
}

export const zeroXApiProvider = new ZeroXApiProvider();
