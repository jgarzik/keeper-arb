import { type Address } from 'viem';
import { type ApiSwapProvider, type ApiSwapQuote } from '../swapInterface.js';
import { CHAIN_ID_HEMI } from '../../chains.js';
import { diag } from '../../logging.js';
import { withRetry } from '../../retry.js';

const EISEN_API_BASE = 'https://hiker.hetz-01.eisenfinance.com/public/v1';

interface EisenQuoteResponse {
  success?: boolean;
  error?: string;
  data?: {
    amountOut?: string;
    outputAmount?: string;
    priceImpact?: number;
    tx?: {
      to: string;
      data: string;
      value?: string;
    };
    // Some APIs return these at top level
    to?: string;
    callData?: string;
    value?: string;
  };
  // Direct response format (no nested data)
  amountOut?: string;
  outputAmount?: string;
  priceImpact?: number;
  tx?: {
    to: string;
    data: string;
    value?: string;
  };
  to?: string;
  callData?: string;
  value?: string;
}

class EisenApiProvider implements ApiSwapProvider {
  readonly name = 'eisen-api';
  readonly supportedChains = [CHAIN_ID_HEMI];

  async getQuote(
    chainId: number,
    tokenIn: Address,
    tokenOut: Address,
    amountIn: bigint,
    sender: Address,
    maxSlippage: number,
    _srcDecimals: number,
    _destDecimals: number
  ): Promise<ApiSwapQuote | null> {
    if (!this.supportedChains.includes(chainId)) {
      return null;
    }

    const url = new URL(`${EISEN_API_BASE}/quote`);
    url.searchParams.set('fromAddress', sender);
    url.searchParams.set('tokenIn', tokenIn);
    url.searchParams.set('tokenOut', tokenOut);
    url.searchParams.set('amount', amountIn.toString());
    url.searchParams.set('slippage', (maxSlippage * 100).toString()); // Convert to percentage
    url.searchParams.set('chainId', chainId.toString());

    try {
      const response = await withRetry(async () => {
        const res = await fetch(url.toString());
        if (!res.ok) {
          throw new Error(`Eisen API HTTP ${res.status}: ${res.statusText}`);
        }
        return res.json() as Promise<EisenQuoteResponse>;
      });

      // Handle various response formats
      const data = response.data || response;

      if (response.success === false || response.error) {
        diag.debug('Eisen API error response', {
          chainId,
          tokenIn,
          tokenOut,
          error: response.error,
        });
        return null;
      }

      // Extract tx data - try various field names
      const txTo = data.tx?.to || data.to;
      const txData = data.tx?.data || data.callData;
      const txValue = data.tx?.value || data.value || '0';
      const amountOutStr = data.amountOut || data.outputAmount;

      if (!txTo || !txData || !amountOutStr) {
        diag.debug('Eisen API missing required fields', {
          chainId,
          tokenIn,
          tokenOut,
          hasTxTo: !!txTo,
          hasTxData: !!txData,
          hasAmountOut: !!amountOutStr,
        });
        return null;
      }

      const quote: ApiSwapQuote = {
        provider: this.name,
        chainId,
        tokenIn,
        tokenOut,
        amountIn,
        amountOut: BigInt(amountOutStr),
        tx: {
          to: txTo as Address,
          data: txData as `0x${string}`,
          value: BigInt(txValue),
        },
        spender: txTo as Address,
        priceImpact: data.priceImpact,
      };

      diag.debug('Eisen API quote', {
        chainId,
        tokenIn,
        tokenOut,
        amountIn: amountIn.toString(),
        amountOut: quote.amountOut.toString(),
        priceImpact: quote.priceImpact,
      });

      return quote;
    } catch (err) {
      diag.warn('Eisen API error', {
        chainId,
        tokenIn,
        tokenOut,
        error: String(err),
      });
      return null;
    }
  }
}

export const eisenApiProvider = new EisenApiProvider();
