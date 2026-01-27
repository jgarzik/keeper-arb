import { type Address } from 'viem';
import { type ApiSwapProvider, type ApiSwapQuote } from '../swapInterface.js';
import { CHAIN_ID_ETHEREUM } from '../../chains.js';
import { diag } from '../../logging.js';
import { withRetry } from '../../retry.js';
import { validateAddress, validateHex, validateBigInt, validateOptionalBigInt } from './validation.js';

/**
 * 0x Swap API v2 provider - aggregates liquidity from Curve, Uniswap, Balancer, etc.
 * Docs: https://0x.org/docs/api
 * Note: Requires ZERO_X_API_KEY environment variable
 */
const ZERO_X_API_BASE = 'https://api.0x.org/swap/allowance-holder';

interface ZeroXQuoteResponse {
  sellAmount: string;
  buyAmount: string;
  transaction: {
    to: string;
    data: string;
    value: string;
    gas: string;
    gasPrice: string;
  };
  issues?: {
    allowance?: { spender: string };
  };
  route?: {
    fills: Array<{ source: string; proportionBps: string }>;
  };
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

    const apiKey = process.env.ZERO_X_API_KEY;
    if (!apiKey) {
      diag.debug('0x API key not configured, skipping');
      return null;
    }

    const url = new URL(`${ZERO_X_API_BASE}/quote`);
    url.searchParams.set('sellToken', tokenIn);
    url.searchParams.set('buyToken', tokenOut);
    url.searchParams.set('sellAmount', amountIn.toString());
    url.searchParams.set('slippagePercentage', (maxSlippage * 100).toFixed(2)); // v2 uses percentage
    url.searchParams.set('taker', sender); // v2 uses 'taker' not 'takerAddress'
    url.searchParams.set('chainId', chainId.toString());

    try {
      const response = await withRetry(async () => {
        const res = await fetch(url.toString(), {
          headers: {
            Accept: 'application/json',
            '0x-api-key': apiKey,
            '0x-version': 'v2',
          },
        });
        if (!res.ok) {
          const text = await res.text();
          throw new Error(`0x API HTTP ${res.status}: ${text.slice(0, 200)}`);
        }
        return res.json() as Promise<ZeroXQuoteResponse>;
      });

      if (!response.buyAmount || !response.transaction) {
        diag.debug('0x API incomplete response', { chainId, tokenIn, tokenOut });
        return null;
      }

      const { transaction } = response;

      // Validate API response fields
      const validatedTo = validateAddress(transaction.to, '0x.transaction.to');
      const validatedData = validateHex(transaction.data, '0x.transaction.data');
      const validatedBuyAmount = validateBigInt(response.buyAmount, '0x.buyAmount');
      const validatedValue = validateOptionalBigInt(transaction.value, '0x.transaction.value');
      // Spender from allowance issues, or fallback to tx.to
      const spenderRaw = response.issues?.allowance?.spender || transaction.to;
      const validatedSpender = validateAddress(spenderRaw, '0x.spender');

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

      // Log which sources contributed (Curve, Uniswap, etc.)
      const sources = response.route?.fills
        ?.filter((f) => parseInt(f.proportionBps) > 0)
        .map((f) => `${f.source}:${(parseInt(f.proportionBps) / 100).toFixed(0)}%`)
        .join(', ');

      diag.debug('0x API quote', {
        chainId,
        tokenIn,
        tokenOut,
        amountIn: amountIn.toString(),
        amountOut: quote.amountOut.toString(),
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
