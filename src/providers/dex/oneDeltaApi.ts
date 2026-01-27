import { type Address } from 'viem';
import { type ApiSwapProvider, type ApiSwapQuote } from '../swapInterface.js';
import { CHAIN_ID_HEMI } from '../../chains.js';
import { diag } from '../../logging.js';
import { withRetry } from '../../retry.js';
import { validateAddress, validateHex, validateBigInt, validateOptionalBigInt } from './validation.js';

/**
 * 1delta API provider for Hemi swaps
 * Uses 0x aggregator backend
 * Docs: https://app.1delta.io
 */
const ONE_DELTA_API_BASE = 'https://api.1delta.io';

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

class OneDeltaApiProvider implements ApiSwapProvider {
  readonly name = '1delta-api';
  readonly supportedChains = [CHAIN_ID_HEMI];

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
}

export const oneDeltaApiProvider = new OneDeltaApiProvider();
