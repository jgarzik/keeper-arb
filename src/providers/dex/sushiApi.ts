import { type Address } from 'viem';
import { type ApiSwapProvider, type ApiSwapQuote, type ProviderHealth } from '../swapInterface.js';
import { CHAIN_ID_HEMI, CHAIN_ID_ETHEREUM } from '../../chains.js';
import { diag } from '../../logging.js';
import { withRetry } from '../../retry.js';
import { validateAddress, validateHex, validateBigInt, validateOptionalBigInt } from './validation.js';

const SUSHI_API_BASE = 'https://api.sushi.com/swap/v7';

interface SushiApiResponse {
  status: 'Success' | 'Partial' | 'NoWay';
  assumedAmountOut?: string;
  priceImpact?: number;
  tx?: {
    from: string;
    to: string;
    data: string;
    value: string;
    gasPrice?: string;
    gas?: string;
  };
  error?: string;
}

class SushiApiProvider implements ApiSwapProvider {
  readonly name = 'sushi-api';
  readonly supportedChains = [CHAIN_ID_ETHEREUM, CHAIN_ID_HEMI];

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

    const url = new URL(`${SUSHI_API_BASE}/${chainId}`);
    url.searchParams.set('tokenIn', tokenIn);
    url.searchParams.set('tokenOut', tokenOut);
    url.searchParams.set('amount', amountIn.toString());
    url.searchParams.set('maxSlippage', maxSlippage.toString());
    url.searchParams.set('sender', sender);

    try {
      const response = await withRetry(async () => {
        const res = await fetch(url.toString());
        if (!res.ok) {
          throw new Error(`Sushi API HTTP ${res.status}: ${res.statusText}`);
        }
        return res.json() as Promise<SushiApiResponse>;
      });

      if (response.status !== 'Success') {
        diag.debug('Sushi API no route', {
          chainId,
          tokenIn,
          tokenOut,
          status: response.status,
          error: response.error,
        });
        return null;
      }

      if (!response.tx || !response.assumedAmountOut) {
        diag.warn('Sushi API success but missing tx/amount', { chainId, tokenIn, tokenOut });
        return null;
      }

      // Validate API response fields
      const validatedTo = validateAddress(response.tx.to, 'sushi.tx.to');
      const validatedData = validateHex(response.tx.data, 'sushi.tx.data');
      const validatedAmountOut = validateBigInt(response.assumedAmountOut, 'sushi.assumedAmountOut');
      const validatedValue = validateOptionalBigInt(response.tx.value, 'sushi.tx.value');

      const quote: ApiSwapQuote = {
        provider: this.name,
        chainId,
        tokenIn,
        tokenOut,
        amountIn,
        amountOut: validatedAmountOut,
        tx: {
          to: validatedTo,
          data: validatedData,
          value: validatedValue,
        },
        spender: validatedTo,
        priceImpact: response.priceImpact,
      };

      diag.debug('Sushi API quote', {
        chainId,
        tokenIn,
        tokenOut,
        amountIn: amountIn.toString(),
        amountOut: quote.amountOut.toString(),
        priceImpact: quote.priceImpact,
      });

      return quote;
    } catch (err) {
      diag.warn('Sushi API error', {
        chainId,
        tokenIn,
        tokenOut,
        error: String(err),
      });
      return null;
    }
  }

  async checkHealth(): Promise<ProviderHealth> {
    const start = Date.now();
    try {
      // Simple GET to the Ethereum swap endpoint to check if API is reachable
      const url = `${SUSHI_API_BASE}/${CHAIN_ID_ETHEREUM}`;
      const res = await fetch(url, { method: 'GET' });
      const latencyMs = Date.now() - start;

      // SushiSwap API returns 400/422 for missing/invalid params but shows it's alive
      if (res.status === 200 || res.status === 400 || res.status === 422) {
        return {
          provider: this.name,
          status: latencyMs > 2000 ? 'degraded' : 'ok',
          latencyMs,
        };
      }

      return {
        provider: this.name,
        status: 'error',
        latencyMs,
        error: `HTTP ${res.status}`,
      };
    } catch (err) {
      return {
        provider: this.name,
        status: 'error',
        latencyMs: Date.now() - start,
        error: String(err),
      };
    }
  }
}

export const sushiApiProvider = new SushiApiProvider();
