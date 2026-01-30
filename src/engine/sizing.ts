import { type Clients } from '../wallet.js';
import { type Config } from '../config.js';
import { type TokenId, requireTokenAddress, requireTokenDecimals, getToken, isStablecoin } from '../tokens.js';
import { CHAIN_ID_HEMI, CHAIN_ID_ETHEREUM } from '../chains.js';
import { getBestPrice } from '../providers/priceAggregator.js';
import { getEthRefPrice } from '../providers/refPricing.js';
import { diag } from '../logging.js';
import { MAX_QUOTE_CALLS, DEFAULT_TEST_VCRED_AMOUNT } from '../constants/timing.js';

// Minimum output ratio for stablecoin swaps (99% - allows 1% slippage max)
const STABLECOIN_MIN_OUTPUT_RATIO = 99n;

export interface SizingResult {
  token: TokenId;
  optimalVcredIn: bigint;
  hemiAmountOut: bigint;
  ethRefAmountOut: bigint;
}

// Check if a trade is profitable at a given size
// Logic: If Hemi gives more X than Ethereum for equivalent input, it's profitable
async function isProfitableAtSize(
  clients: Clients,
  token: TokenId,
  vcredIn: bigint
): Promise<{ profitable: boolean; hemiOut: bigint; ethOut: bigint } | null> {
  const tokenMeta = getToken(token);
  const vcredAddress = requireTokenAddress('VCRED', CHAIN_ID_HEMI);
  const tokenHemi = requireTokenAddress(token, CHAIN_ID_HEMI);
  const tokenEth = tokenMeta.chains[CHAIN_ID_ETHEREUM]?.address;
  const usdcEth = requireTokenAddress('USDC', CHAIN_ID_ETHEREUM);

  if (!tokenEth) {
    return null;
  }

  // Step 1: Price VCRED -> X on Hemi
  const hemiQuote = await getBestPrice(CHAIN_ID_HEMI, vcredAddress, tokenHemi, vcredIn);
  if (!hemiQuote) {
    return null;
  }

  // Sanity check for stablecoins: output value must be >= input value
  // If swapping $1000 VCRED for stablecoin X, we must get >= $990 of X (1% slippage max)
  if (isStablecoin(token)) {
    const vcredDecimals = requireTokenDecimals('VCRED', CHAIN_ID_HEMI);
    const tokenDecimals = requireTokenDecimals(token, CHAIN_ID_HEMI);

    // Normalize to same decimal basis for comparison
    // vcredIn / 10^vcredDec should be <= hemiOut / 10^tokenDec * (100/99)
    // => vcredIn * 10^tokenDec * 99 <= hemiOut * 10^vcredDec * 100
    const vcredNorm = vcredIn * (10n ** BigInt(tokenDecimals)) * STABLECOIN_MIN_OUTPUT_RATIO;
    const hemiNorm = hemiQuote.amountOut * (10n ** BigInt(vcredDecimals)) * 100n;

    if (hemiNorm < vcredNorm) {
      diag.debug('Stablecoin sanity check failed', {
        token,
        vcredIn: vcredIn.toString(),
        hemiOut: hemiQuote.amountOut.toString(),
        reason: 'output value < input value (loss trade)',
      });
      return { profitable: false, hemiOut: hemiQuote.amountOut, ethOut: 0n };
    }
  }

  // Step 2: Quote equivalent USDC -> X on Ethereum
  const vcredDecimals = requireTokenDecimals('VCRED', CHAIN_ID_HEMI);
  const usdcDecimals = requireTokenDecimals('USDC', CHAIN_ID_ETHEREUM);
  const decimalDiff = vcredDecimals - usdcDecimals;
  const usdcAmount = decimalDiff >= 0
    ? vcredIn / (10n ** BigInt(decimalDiff))
    : vcredIn * (10n ** BigInt(-decimalDiff));

  const ethRefQuote = await getEthRefPrice(clients, usdcEth, tokenEth, usdcAmount);
  if (!ethRefQuote) {
    return null;
  }

  // Step 3: If Hemi gives more X than Ethereum, it's profitable
  return {
    profitable: hemiQuote.amountOut > ethRefQuote.amountOut,
    hemiOut: hemiQuote.amountOut,
    ethOut: ethRefQuote.amountOut,
  };
}

// Binary search to find maximum profitable trade size
export async function findOptimalSize(
  clients: Clients,
  config: Config,
  token: TokenId,
  availableVcred: bigint
): Promise<SizingResult | null> {
  const minSize = config.minSwapVcred;
  const maxSize = availableVcred < config.maxSwapVcredCap ? availableVcred : config.maxSwapVcredCap;

  if (maxSize < minSize) {
    diag.debug('Insufficient VCRED for trade', {
      available: availableVcred.toString(),
      minRequired: minSize.toString(),
    });
    return null;
  }

  let quoteCalls = 0;
  const vcredDecimals = requireTokenDecimals('VCRED', CHAIN_ID_HEMI);
  const granularity = 10n ** BigInt(vcredDecimals);

  async function checkSize(vcredIn: bigint) {
    if (quoteCalls >= MAX_QUOTE_CALLS) return null;
    quoteCalls += 2; // Each check makes 2 quote calls
    return isProfitableAtSize(clients, token, vcredIn);
  }

  // Start with default test size
  let testSize = DEFAULT_TEST_VCRED_AMOUNT * granularity;
  if (testSize > maxSize) testSize = maxSize;
  if (testSize < minSize) testSize = minSize;

  const initial = await checkSize(testSize);
  if (!initial) {
    diag.debug('Could not get initial quote', { token, testSize: testSize.toString() });
    return null;
  }

  if (!initial.profitable) {
    diag.info('Not profitable at base size', { token });
    return null;
  }

  // Profitable at base size, find maximum profitable size
  let good = testSize;
  let goodResult = initial;
  let bad = maxSize + granularity;

  // Expand to find upper bound
  while (good < maxSize && quoteCalls < MAX_QUOTE_CALLS) {
    const next = good * 2n > maxSize ? maxSize : good * 2n;
    const result = await checkSize(next);

    if (result && result.profitable) {
      good = next;
      goodResult = result;
    } else {
      bad = next;
      break;
    }
  }

  // Binary search between good and bad
  while (bad - good > granularity && quoteCalls < MAX_QUOTE_CALLS) {
    const mid = (good + bad) / 2n;
    const result = await checkSize(mid);

    if (result && result.profitable) {
      good = mid;
      goodResult = result;
    } else {
      bad = mid;
    }
  }

  diag.info('Optimal size found', {
    token,
    vcredIn: good.toString(),
    hemiOut: goodResult.hemiOut.toString(),
    ethRefOut: goodResult.ethOut.toString(),
    quoteCalls,
  });

  return {
    token,
    optimalVcredIn: good,
    hemiAmountOut: goodResult.hemiOut,
    ethRefAmountOut: goodResult.ethOut,
  };
}

// Pure binary search logic for testing
export function binarySearchProfitable(
  profitAtSize: (size: bigint) => bigint,
  minSize: bigint,
  maxSize: bigint,
  minProfit: bigint,
  granularity: bigint = 1n
): bigint | null {
  if (maxSize < minSize) return null;

  if (profitAtSize(minSize) <= minProfit) {
    return null;
  }

  let good = minSize;
  let bad = maxSize + granularity;

  while (bad - good > granularity) {
    const mid = (good + bad) / 2n;
    if (profitAtSize(mid) > minProfit) {
      good = mid;
    } else {
      bad = mid;
    }
  }

  return good;
}
