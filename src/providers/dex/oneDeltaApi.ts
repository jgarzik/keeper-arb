import { type Address } from 'viem';
import { type ApiSwapProvider, type ApiSwapQuote, type ApiPriceProvider, type ApiPriceQuote, type ProviderHealth } from '../swapInterface.js';
import { CHAIN_ID_HEMI } from '../../chains.js';
import { diag } from '../../logging.js';
import { withRetry } from '../../retry.js';
import { validateAddress, validateHex, validateBigInt, validateOptionalBigInt } from './validation.js';
import { ONE_DELTA_API_BASE } from '../../constants/api.js';
import { HEALTH_CHECK_RPC_DEGRADED_THRESHOLD_MS } from '../../constants/timing.js';

interface OneDeltaQuoteResponse {
  // Response structure from 0x backend
  sellAmount?: string;
  buyAmount?: string;
  to?: string;
  data?: string;
  value?: string;
  allowanceTarget?: string;
  // Error response
  message?: string;
}

class OneDeltaApiProvider implements ApiSwapProvider, ApiPriceProvider {
  readonly name = '1delta-api';
  readonly supportedChains = [CHAIN_ID_HEMI];

  async getQuote(
    chainId: number,
    tokenIn: Address,
    tokenOut: Address,
    amountIn: bigint,
    _sender: Address,
    _maxSlippage: number,
    _srcDecimals: number,
    _destDecimals: number
  ): Promise<ApiSwapQuote | null> {
    if (!this.supportedChains.includes(chainId)) {
      return null;
    }

    const url = new URL(`${ONE_DELTA_API_BASE}/quote`);
    url.searchParams.set('chainId', chainId.toString());
    url.searchParams.set('sellToken', tokenIn);
    url.searchParams.set('buyToken', tokenOut);
    url.searchParams.set('sellAmount', amountIn.toString());
    url.searchParams.set('aggregator', '0x'); // Use 0x backend

    try {
      const response = await withRetry(async () => {
        const res = await fetch(url.toString(), {
          headers: { Accept: 'application/json' },
        });
        // 1delta returns 404 with JSON body for "no route" - still parse it
        const data = await res.json() as OneDeltaQuoteResponse;
        if (!res.ok && !data.message) {
          throw new Error(`1delta API HTTP ${res.status}`);
        }
        return data;
      });

      // Check for error or "no route" response
      if (response.message) {
        diag.debug('1delta API no route', {
          chainId,
          tokenIn,
          tokenOut,
          message: response.message,
        });
        return null;
      }

      if (!response.buyAmount || !response.to || !response.data) {
        diag.debug('1delta API incomplete response', { chainId, tokenIn, tokenOut });
        return null;
      }

      // Validate API response fields
      const validatedTo = validateAddress(response.to, '1delta.to');
      const validatedData = validateHex(response.data, '1delta.data');
      const validatedBuyAmount = validateBigInt(response.buyAmount, '1delta.buyAmount');
      const validatedValue = validateOptionalBigInt(response.value, '1delta.value');
      const validatedSpender = validateAddress(
        response.allowanceTarget || response.to,
        '1delta.spender'
      );

      const quote: ApiSwapQuote = {
        provider: this.name,
        chainId,
        tokenIn,
        tokenOut,
        amountIn,
        amountOut: validatedBuyAmount,
        tx: {
          to: validatedTo,
          data: validatedData,
          value: validatedValue,
        },
        spender: validatedSpender,
        quotedAt: Date.now(),
      };

      diag.debug('1delta API quote', {
        chainId,
        tokenIn,
        tokenOut,
        amountIn: amountIn.toString(),
        amountOut: quote.amountOut.toString(),
      });

      return quote;
    } catch (err) {
      diag.debug('1delta API error', {
        chainId,
        tokenIn,
        tokenOut,
        error: String(err),
      });
      return null;
    }
  }

  async getPrice(
    chainId: number,
    tokenIn: Address,
    tokenOut: Address,
    amountIn: bigint
  ): Promise<ApiPriceQuote | null> {
    // Use getQuote internally but only return price info
    // Decimals don't matter for 1delta, pass dummy values
    const quote = await this.getQuote(chainId, tokenIn, tokenOut, amountIn, '0x0000000000000000000000000000000000000000', 0.01, 18, 18);
    if (!quote) return null;
    return {
      provider: this.name,
      chainId,
      tokenIn,
      tokenOut,
      amountIn,
      amountOut: quote.amountOut,
    };
  }

  async checkHealth(): Promise<ProviderHealth> {
    const start = Date.now();
    try {
      // Call the quote endpoint with minimal params to check connectivity
      const url = new URL(`${ONE_DELTA_API_BASE}/quote`);
      url.searchParams.set('chainId', CHAIN_ID_HEMI.toString());
      // Use WETH addresses on Hemi
      url.searchParams.set('sellToken', '0x4200000000000000000000000000000000000006');
      url.searchParams.set('buyToken', '0xad11a8beb98bbf61dbb1aa0f6d6f2ecd87b35afa'); // USDC on Hemi
      url.searchParams.set('sellAmount', '1000000000000000'); // 0.001 ETH
      url.searchParams.set('aggregator', '0x');

      const res = await fetch(url.toString(), {
        headers: { Accept: 'application/json' },
      });

      const latencyMs = Date.now() - start;

      // 1delta returns 404 with JSON for "no route" but that still means API is alive
      if (res.ok || res.status === 404) {
        return {
          provider: this.name,
          status: latencyMs > HEALTH_CHECK_RPC_DEGRADED_THRESHOLD_MS ? 'degraded' : 'ok',
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

export const oneDeltaApiProvider = new OneDeltaApiProvider();
