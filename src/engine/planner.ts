import { type Clients } from '../wallet.js';
import { CHAIN_ID_HEMI, CHAIN_ID_ETHEREUM } from '../chains.js';
import { ARB_TARGET_TOKENS, type TokenId, requireTokenAddress, getToken } from '../tokens.js';
import { sushiSwapHemi } from '../providers/sushiSwap.js';
import { getUniswapRefPrice, calculateDiscount } from '../providers/uniswapRef.js';
import { diag } from '../logging.js';
import { type Config } from '../config.js';

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
  vcredTestAmount: bigint = 1000n * 10n ** 18n // 1000 VCRED for testing
): Promise<Opportunity[]> {
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
      // Get Hemi swap quote: VCRED -> Token
      const hemiQuote = await sushiSwapHemi.quoteExactIn(
        clients,
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
      const usdcTestAmount = vcredTestAmount / 10n ** 12n; // VCRED 18 decimals -> USDC 6 decimals

      if (!ethTokenAddr) {
        // Token only exists on Hemi, can't compare
        diag.debug('Token not on Ethereum', { tokenId });
        continue;
      }

      const ethRefPrice = await getUniswapRefPrice(
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
      const discount = calculateDiscount(hemiQuote.amountOut, ethRefPrice.amountOut);

      diag.info('Opportunity check', {
        tokenId,
        hemiOut: hemiQuote.amountOut.toString(),
        ethRefOut: ethRefPrice.amountOut.toString(),
        discount: `${discount}%`,
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
