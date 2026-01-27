import { type Address } from 'viem';
import { type Clients, getPublicClient, getWalletClient, getNextNonce, getTokenAllowance, approveToken } from '../wallet.js';
import { type ApiSwapProvider, type ApiSwapQuote } from './swapInterface.js';
import { sushiApiProvider, eisenApiProvider } from './dex/index.js';
import { diag } from '../logging.js';

const MAX_UINT256 = 2n ** 256n - 1n;

// All available API providers
// NOTE: Eisen disabled - requires authentication (401 Unauthorized)
const ALL_PROVIDERS: ApiSwapProvider[] = [
  sushiApiProvider,
  // eisenApiProvider,  // TODO: Enable when API auth is configured
];

// Default slippage: 0.5%
const DEFAULT_MAX_SLIPPAGE = 0.005;

/**
 * Get best swap quote from all available providers
 */
export async function getBestSwapQuote(
  clients: Clients,
  chainId: number,
  tokenIn: Address,
  tokenOut: Address,
  amountIn: bigint,
  maxSlippage = DEFAULT_MAX_SLIPPAGE
): Promise<ApiSwapQuote | null> {
  // Filter providers that support this chain
  const providers = ALL_PROVIDERS.filter((p) =>
    p.supportedChains.includes(chainId)
  );

  if (providers.length === 0) {
    diag.warn('No providers available for chain', { chainId });
    return null;
  }

  // Query all providers in parallel
  const quotes = await Promise.all(
    providers.map((p) =>
      p.getQuote(chainId, tokenIn, tokenOut, amountIn, clients.address, maxSlippage)
    )
  );

  // Filter valid quotes and find best by amountOut
  const validQuotes = quotes.filter((q): q is ApiSwapQuote => q !== null);

  if (validQuotes.length === 0) {
    diag.debug('No valid quotes from any provider', {
      chainId,
      tokenIn,
      tokenOut,
      amountIn: amountIn.toString(),
      providersQueried: providers.map((p) => p.name),
    });
    return null;
  }

  // Sort by amountOut descending (use bigint comparison to avoid precision loss)
  validQuotes.sort((a, b) => {
    if (b.amountOut > a.amountOut) return 1;
    if (b.amountOut < a.amountOut) return -1;
    return 0;
  });
  const best = validQuotes[0];

  diag.info('Best swap quote selected', {
    provider: best.provider,
    chainId,
    tokenIn,
    tokenOut,
    amountIn: amountIn.toString(),
    amountOut: best.amountOut.toString(),
    quotesReceived: validQuotes.length,
  });

  return best;
}

/**
 * Ensure token approval for a spender
 */
async function ensureApproval(
  clients: Clients,
  chainId: number,
  token: Address,
  spender: Address,
  amount: bigint
): Promise<void> {
  const allowance = await getTokenAllowance(clients, chainId, token, spender);
  if (allowance < amount) {
    diag.info('Approving token for swap', { chainId, token, spender });
    const hash = await approveToken(clients, chainId, token, spender, MAX_UINT256);
    const publicClient = getPublicClient(clients, chainId);
    await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
  }
}

/**
 * Execute a swap using a pre-built quote
 */
export async function executeSwap(
  clients: Clients,
  quote: ApiSwapQuote
): Promise<`0x${string}`> {
  const { chainId, tokenIn, amountIn, tx, spender } = quote;
  const publicClient = getPublicClient(clients, chainId);
  const walletClient = getWalletClient(clients, chainId);

  // 1. Ensure approval to spender
  await ensureApproval(clients, chainId, tokenIn, spender, amountIn);

  // 2. Simulate tx first (eth_call preflight)
  try {
    await publicClient.call({
      to: tx.to,
      data: tx.data,
      value: tx.value,
      account: clients.account,
    });
  } catch (err) {
    throw new Error(`Swap simulation failed: ${String(err)}`);
  }

  // 3. Send pre-built tx
  const nonce = await getNextNonce(clients, chainId);
  const hash = await walletClient.sendTransaction({
    to: tx.to,
    data: tx.data,
    value: tx.value,
    nonce: Number(nonce),
  });

  diag.info('Swap tx submitted', {
    provider: quote.provider,
    chainId,
    tokenIn: quote.tokenIn,
    tokenOut: quote.tokenOut,
    amountIn: quote.amountIn.toString(),
    expectedOut: quote.amountOut.toString(),
    txHash: hash,
  });

  return hash;
}
