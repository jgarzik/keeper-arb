import { type Clients } from '../wallet.js';
import { CHAIN_ID_HEMI, CHAIN_ID_ETHEREUM } from '../chains.js';
import { ARB_TARGET_TOKENS, type TokenId, requireTokenAddress, getToken, requireTokenDecimals } from '../tokens.js';
import { getBestPrice } from '../providers/priceAggregator.js';
import { getEthRefPrice, calculateDiscountBps, formatDiscountPercent } from '../providers/refPricing.js';
import { diag } from '../logging.js';
import { type Config } from '../config.js';
import { DEFAULT_TEST_VCRED_AMOUNT } from '../constants/timing.js';

export interface Opportunity {
  token: TokenId;
  hemiAmountOut: bigint;
  ethRefAmountOut: bigint;
  discountPercent: number;
  vcredIn: bigint;
}

// Detect arbitrage opportunities by comparing Hemi prices to Ethereum reference
export async function detectOpportunities(
  clients: Clients,
  config: Config,
  vcredTestAmount?: bigint
): Promise<Opportunity[]> {
  // Default: test amount using correct decimals
  if (!vcredTestAmount) {
    const vcredDecimals = requireTokenDecimals('VCRED', CHAIN_ID_HEMI);
    vcredTestAmount = DEFAULT_TEST_VCRED_AMOUNT * (10n ** BigInt(vcredDecimals));
  }
  const opportunities: Opportunity[] = [];
  const vcredAddress = requireTokenAddress('VCRED', CHAIN_ID_HEMI);

  for (const tokenId of ARB_TARGET_TOKENS) {
    const tokenMeta = getToken(tokenId);
    const hemiTokenAddr = tokenMeta.chains[CHAIN_ID_HEMI]?.address;
    const ethTokenAddr = tokenMeta.chains[CHAIN_ID_ETHEREUM]?.address;

    if (!hemiTokenAddr) {
      diag.debug('Skipping token - no Hemi address', { tokenId });
      continue;
    }

    try {
      // Get Hemi price: VCRED -> Token (best price from all providers)
      const hemiQuote = await getBestPrice(
        CHAIN_ID_HEMI,
        vcredAddress,
        hemiTokenAddr,
        vcredTestAmount
      );

      if (!hemiQuote) {
        diag.debug('No Hemi quote available', { tokenId });
        continue;
      }

      // Get Ethereum reference price
      // We compare: "how much token X can we get for equivalent USDC on ETH?"
      // For reference, assume 1 VCRED ≈ value that would get us the same token amount
      // Actually, we need USDC → Token quote on Ethereum
      const usdcAddress = requireTokenAddress('USDC', CHAIN_ID_ETHEREUM);

      // Quote equivalent USDC amount -> Token on Ethereum
      // Assuming VCRED ≈ USDC for test purposes, use same nominal amount
      const vcredDecimals = requireTokenDecimals('VCRED', CHAIN_ID_HEMI);
      const usdcDecimals = requireTokenDecimals('USDC', CHAIN_ID_ETHEREUM);
      const decimalDiff = vcredDecimals - usdcDecimals;
      const usdcTestAmount = decimalDiff >= 0 
        ? vcredTestAmount / (10n ** BigInt(decimalDiff))
        : vcredTestAmount * (10n ** BigInt(-decimalDiff));

      if (!ethTokenAddr) {
        // Token only exists on Hemi, can't compare
        diag.debug('Token not on Ethereum', { tokenId });
        continue;
      }

      const ethRefPrice = await getEthRefPrice(
        clients,
        usdcAddress,
        ethTokenAddr,
        usdcTestAmount
      );

      if (!ethRefPrice) {
        diag.debug('No Ethereum ref price', { tokenId });
        continue;
      }

      // Calculate discount (positive = cheaper on Hemi)
      const discountBps = calculateDiscountBps(hemiQuote.amountOut, ethRefPrice.amountOut);
      const discount = Number(discountBps) / 100; // for sorting/comparison

      diag.info('Opportunity check', {
        tokenId,
        hemiOut: hemiQuote.amountOut.toString(),
        ethRefOut: ethRefPrice.amountOut.toString(),
        discount: formatDiscountPercent(discountBps),
      });

      // If we get MORE token on Hemi than expected from Ethereum price, it's underpriced
      if (discount > 0) {
        opportunities.push({
          token: tokenId,
          hemiAmountOut: hemiQuote.amountOut,
          ethRefAmountOut: ethRefPrice.amountOut,
          discountPercent: discount,
          vcredIn: vcredTestAmount,
        });
      }
    } catch (err) {
      diag.warn('Error checking opportunity', { tokenId, error: String(err) });
    }
  }

  // Sort by discount (highest first)
  opportunities.sort((a, b) => b.discountPercent - a.discountPercent);

  return opportunities;
}

// Get the best opportunity (highest discount)
export async function getBestOpportunity(
  clients: Clients,
  config: Config
): Promise<Opportunity | null> {
  const opportunities = await detectOpportunities(clients, config);
  return opportunities.length > 0 ? opportunities[0] : null;
}
