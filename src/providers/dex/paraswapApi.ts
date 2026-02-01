import { type Address } from 'viem';
import { type ApiSwapProvider, type ApiSwapQuote, type ProviderHealth } from '../swapInterface.js';
import { CHAIN_ID_ETHEREUM } from '../../chains.js';
import { diag } from '../../logging.js';
import { withRetry } from '../../retry.js';
import { validateAddress, validateHex, validateBigInt } from './validation.js';
import { PARASWAP_API_BASE } from '../../constants/api.js';
import { HEALTH_CHECK_RPC_DEGRADED_THRESHOLD_MS } from '../../constants/timing.js';

interface ParaswapPriceResponse {
  priceRoute: {
    blockNumber: number;
    network: number;
    srcToken: string;
    srcDecimals: number;
    srcAmount: string;
    destToken: string;
    destDecimals: number;
    destAmount: string;
    bestRoute: unknown[];
    gasCostUSD: string;
    gasCost: string;
    contractAddress: string;
    contractMethod: string;
    tokenTransferProxy: string;
  };
}

interface ParaswapTxResponse {
  from: string;
  to: string;
  value: string;
  data: string;
  chainId: number;
}

class ParaswapApiProvider implements ApiSwapProvider {
  readonly name = 'paraswap';
  readonly supportedChains = [CHAIN_ID_ETHEREUM];

  async getQuote(
    chainId: number,
    tokenIn: Address,
    tokenOut: Address,
    amountIn: bigint,
    sender: Address,
    maxSlippage: number,
    srcDecimals: number,
    destDecimals: number
  ): Promise<ApiSwapQuote | null> {
    if (!this.supportedChains.includes(chainId)) {
      return null;
    }

    try {
      // Step 1: Get price route
      const priceUrl = new URL(`${PARASWAP_API_BASE}/prices`);
      priceUrl.searchParams.set('srcToken', tokenIn);
      priceUrl.searchParams.set('destToken', tokenOut);
      priceUrl.searchParams.set('amount', amountIn.toString());
      priceUrl.searchParams.set('srcDecimals', srcDecimals.toString());
      priceUrl.searchParams.set('destDecimals', destDecimals.toString());
      priceUrl.searchParams.set('side', 'SELL');
      priceUrl.searchParams.set('network', chainId.toString());

      const priceResponse = await withRetry(async () => {
        const res = await fetch(priceUrl.toString(), {
          headers: { Accept: 'application/json' },
        });
        if (!res.ok) {
          const text = await res.text();
          throw new Error(`Paraswap prices HTTP ${res.status}: ${text.slice(0, 200)}`);
        }
        return res.json() as Promise<ParaswapPriceResponse>;
      });

      if (!priceResponse.priceRoute?.destAmount) {
        diag.debug('Paraswap no route found', { chainId, tokenIn, tokenOut });
        return null;
      }

      const { priceRoute } = priceResponse;

      // Step 2: Build transaction
      const txUrl = new URL(`${PARASWAP_API_BASE}/transactions/${chainId}`);
      txUrl.searchParams.set('ignoreChecks', 'true'); // Skip balance checks

      const slippageBps = Math.floor(maxSlippage * 10000);
      const txBody = {
        srcToken: tokenIn,
        destToken: tokenOut,
        srcAmount: amountIn.toString(),
        priceRoute,
        userAddress: sender,
        partner: 'anon',
        slippage: slippageBps, // API calculates minDestAmount from priceRoute.destAmount
      };

      const txResponse = await withRetry(async () => {
        const res = await fetch(txUrl.toString(), {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(txBody),
        });
        if (!res.ok) {
          const text = await res.text();
          throw new Error(`Paraswap tx HTTP ${res.status}: ${text.slice(0, 200)}`);
        }
        return res.json() as Promise<ParaswapTxResponse>;
      });

      if (!txResponse.to || !txResponse.data) {
        diag.debug('Paraswap incomplete tx response', { chainId, tokenIn, tokenOut });
        return null;
      }

      // Validate response fields
      const validatedTo = validateAddress(txResponse.to, 'paraswap.tx.to');
      const validatedData = validateHex(txResponse.data, 'paraswap.tx.data');
      const validatedDestAmount = validateBigInt(priceRoute.destAmount, 'paraswap.destAmount');
      const validatedSpender = validateAddress(
        priceRoute.tokenTransferProxy,
        'paraswap.tokenTransferProxy'
      );
      const validatedValue = txResponse.value ? BigInt(txResponse.value) : 0n;

      const quote: ApiSwapQuote = {
        provider: this.name,
        chainId,
        tokenIn,
        tokenOut,
        amountIn,
        amountOut: validatedDestAmount,
        tx: {
          to: validatedTo,
          data: validatedData,
          value: validatedValue,
        },
        spender: validatedSpender,
        quotedAt: Date.now(),
      };

      diag.debug('Paraswap quote', {
        chainId,
        tokenIn,
        tokenOut,
        amountIn: amountIn.toString(),
        amountOut: quote.amountOut.toString(),
        route: priceRoute.contractMethod,
      });

      return quote;
    } catch (err) {
      diag.warn('Paraswap API error', {
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
      // Simple price check for WETH -> USDC
      const url = new URL(`${PARASWAP_API_BASE}/prices`);
      url.searchParams.set('srcToken', '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'); // WETH
      url.searchParams.set('destToken', '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'); // USDC
      url.searchParams.set('amount', '1000000000000000'); // 0.001 ETH
      url.searchParams.set('srcDecimals', '18');
      url.searchParams.set('destDecimals', '6');
      url.searchParams.set('side', 'SELL');
      url.searchParams.set('network', '1');

      const res = await fetch(url.toString(), {
        headers: { Accept: 'application/json' },
      });

      const latencyMs = Date.now() - start;

      if (res.ok) {
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

export const paraswapApiProvider = new ParaswapApiProvider();
