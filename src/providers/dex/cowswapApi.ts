import { type Address, encodeFunctionData } from 'viem';
import { type ApiSwapProvider, type ApiSwapQuote } from '../swapInterface.js';
import { CHAIN_ID_ETHEREUM } from '../../chains.js';
import { diag } from '../../logging.js';
import { withRetry } from '../../retry.js';
import { validateAddress, validateBigInt } from './validation.js';
import { COWSWAP_API_BASE, COWSWAP_VAULT_RELAYER, COWSWAP_SETTLEMENT } from '../../constants/api.js';

// CowSwap order types
interface CowSwapQuoteRequest {
  sellToken: string;
  buyToken: string;
  sellAmountBeforeFee: string;
  from: string;
  kind: 'sell';
  signingScheme: 'presign';
  receiver: string;
  appData: string;
  partiallyFillable: boolean;
  sellTokenBalance: 'erc20';
  buyTokenBalance: 'erc20';
}

interface CowSwapQuoteResponse {
  quote: {
    sellToken: string;
    buyToken: string;
    sellAmount: string;
    buyAmount: string;
    feeAmount: string;
    kind: string;
    partiallyFillable: boolean;
    validTo: number;
    appData: string;
    receiver: string;
    sellTokenBalance: string;
    buyTokenBalance: string;
  };
  from: string;
  id: number;
}

interface CowSwapOrderRequest {
  sellToken: string;
  buyToken: string;
  sellAmount: string;
  buyAmount: string;
  feeAmount: string;
  kind: 'sell';
  validTo: number;
  receiver: string;
  appData: string;
  partiallyFillable: boolean;
  sellTokenBalance: 'erc20';
  buyTokenBalance: 'erc20';
  signingScheme: 'presign';
  from: string;
  signature: string;
}

export type CowSwapOrderStatus = 'open' | 'fulfilled' | 'cancelled' | 'expired' | 'presignaturePending';

export interface CowSwapOrderInfo {
  uid: string;
  status: CowSwapOrderStatus;
  executedBuyAmount?: string;
  executedSellAmount?: string;
}

// AppData: generic "keeper bot" identifier (keccak256 of "keeper-arb")
const APP_DATA = '0x0000000000000000000000000000000000000000000000000000000000000000';

// GPv2Settlement.setPreSignature(bytes orderUid, bool signed) ABI
const SET_PRE_SIGNATURE_ABI = [
  {
    name: 'setPreSignature',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'orderUid', type: 'bytes' },
      { name: 'signed', type: 'bool' },
    ],
    outputs: [],
  },
] as const;

/**
 * Get a CowSwap quote using presign signing scheme.
 * Returns both the quote response and an ApiSwapQuote for comparison.
 */
async function getCowQuote(
  tokenIn: Address,
  tokenOut: Address,
  amountIn: bigint,
  sender: Address,
  slippageBps: number
): Promise<{ quoteResponse: CowSwapQuoteResponse; minBuyAmount: bigint } | null> {
  const body: CowSwapQuoteRequest = {
    sellToken: tokenIn,
    buyToken: tokenOut,
    sellAmountBeforeFee: amountIn.toString(),
    from: sender,
    kind: 'sell',
    signingScheme: 'presign',
    receiver: sender,
    appData: APP_DATA,
    partiallyFillable: false,
    sellTokenBalance: 'erc20',
    buyTokenBalance: 'erc20',
  };

  const response = await withRetry(async () => {
    const res = await fetch(`${COWSWAP_API_BASE}/quote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`CowSwap quote HTTP ${res.status}: ${errText}`);
    }
    return res.json() as Promise<CowSwapQuoteResponse>;
  });

  const buyAmount = validateBigInt(response.quote.buyAmount, 'cowswap.buyAmount');
  // Apply slippage tolerance to minimum buy amount
  const slippageMultiplier = 10000n - BigInt(slippageBps);
  const minBuyAmount = (buyAmount * slippageMultiplier) / 10000n;

  return { quoteResponse: response, minBuyAmount };
}

/**
 * Create a CowSwap order via the API.
 * Returns the order UID.
 */
export async function createCowSwapOrder(
  quoteResponse: CowSwapQuoteResponse,
  sender: Address,
  minBuyAmount: bigint
): Promise<string> {
  const q = quoteResponse.quote;

  const order: CowSwapOrderRequest = {
    sellToken: q.sellToken,
    buyToken: q.buyToken,
    sellAmount: q.sellAmount,
    buyAmount: minBuyAmount.toString(),
    feeAmount: '0', // CowSwap v2: fees embedded in sell/buy amounts
    kind: 'sell',
    validTo: q.validTo,
    receiver: q.receiver,
    appData: q.appData,
    partiallyFillable: q.partiallyFillable,
    sellTokenBalance: 'erc20' as const,
    buyTokenBalance: 'erc20' as const,
    signingScheme: 'presign',
    from: sender,
    signature: sender, // For presign, signature is the signer address
  };

  const uid = await withRetry(async () => {
    const res = await fetch(`${COWSWAP_API_BASE}/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(order),
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`CowSwap create order HTTP ${res.status}: ${errText}`);
    }
    return res.json() as Promise<string>;
  });

  return uid;
}

/**
 * Build the setPreSignature transaction calldata.
 */
export function buildPreSignatureTx(orderUid: string): { to: Address; data: `0x${string}`; value: bigint } {
  const data = encodeFunctionData({
    abi: SET_PRE_SIGNATURE_ABI,
    functionName: 'setPreSignature',
    args: [orderUid as `0x${string}`, true],
  });

  return {
    to: COWSWAP_SETTLEMENT as Address,
    data,
    value: 0n,
  };
}

/**
 * Poll CowSwap API for order status.
 */
export async function getCowSwapOrderStatus(orderUid: string): Promise<CowSwapOrderInfo> {
  const res = await fetch(`${COWSWAP_API_BASE}/orders/${orderUid}`);
  if (!res.ok) {
    throw new Error(`CowSwap order status HTTP ${res.status}`);
  }
  const order = await res.json() as Record<string, unknown>;
  return {
    uid: orderUid,
    status: order.status as CowSwapOrderStatus,
    executedBuyAmount: order.executedBuyAmount as string | undefined,
    executedSellAmount: order.executedSellAmount as string | undefined,
  };
}

class CowSwapApiProvider implements ApiSwapProvider {
  readonly name = 'cowswap';
  readonly supportedChains = [CHAIN_ID_ETHEREUM];

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

    try {
      const slippageBps = Math.round(maxSlippage * 10000);
      const result = await getCowQuote(tokenIn, tokenOut, amountIn, sender, slippageBps);
      if (!result) return null;

      const { quoteResponse, minBuyAmount } = result;
      const q = quoteResponse.quote;

      const validatedSellToken = validateAddress(q.sellToken, 'cowswap.sellToken');
      const validatedBuyToken = validateAddress(q.buyToken, 'cowswap.buyToken');
      const buyAmount = validateBigInt(q.buyAmount, 'cowswap.buyAmount');
      const sellAmount = validateBigInt(q.sellAmount, 'cowswap.sellAmount');

      // Build a "virtual" tx that points to the settlement contract
      // The actual execution path uses createCowSwapOrder + setPreSignature
      // This tx is a placeholder for the aggregator comparison
      const preSignTx = buildPreSignatureTx('0x' + '00'.repeat(56)); // dummy uid for quote

      const quote: ApiSwapQuote = {
        provider: this.name,
        chainId,
        tokenIn: validatedSellToken,
        tokenOut: validatedBuyToken,
        amountIn: sellAmount,
        amountOut: buyAmount,
        tx: preSignTx,
        spender: COWSWAP_VAULT_RELAYER as Address,
        quotedAt: Date.now(),
      };

      diag.debug('CowSwap quote', {
        chainId,
        tokenIn,
        tokenOut,
        amountIn: amountIn.toString(),
        sellAmount: sellAmount.toString(),
        buyAmount: buyAmount.toString(),
        minBuyAmount: minBuyAmount.toString(),
        validTo: q.validTo,
      });

      return quote;
    } catch (err) {
      diag.warn('CowSwap API error', {
        chainId,
        tokenIn,
        tokenOut,
        error: String(err),
      });
      return null;
    }
  }
}

export const cowswapApiProvider = new CowSwapApiProvider();
