import { type Clients, getPublicClient } from '../wallet.js';
import { type Config } from '../config.js';
import { CHAIN_ID_HEMI, CHAIN_ID_ETHEREUM } from '../chains.js';
import { type TokenId, requireTokenAddress, getToken } from '../tokens.js';
import { sushiSwapHemi, sushiSwapEthereum } from '../providers/sushiSwap.js';
import { stargateHemiToEth, stargateEthToHemi } from '../providers/stargateBridge.js';
import { hemiTunnelHemiToEth } from '../providers/hemiTunnel.js';
import { diag } from '../logging.js';

export interface ProfitEstimate {
  token: TokenId;
  vcredIn: bigint;
  xOut: bigint;           // Amount of token X from first swap
  usdcOut: bigint;        // Amount of USDC from Ethereum swap
  vcredOut: bigint;       // Amount of VCRED from closing swap
  gasEstimateHemi: bigint;
  gasEstimateEth: bigint;
  bridgeFeeOut: bigint;   // Bridge X to Ethereum
  bridgeFeeBack: bigint;  // Bridge USDC back to Hemi
  totalFeesVcred: bigint; // All fees converted to VCRED
  grossProfitVcred: bigint;
  netProfitVcred: bigint;
}

// Estimate end-to-end profit for a complete arb cycle
export async function estimateProfit(
  clients: Clients,
  config: Config,
  token: TokenId,
  vcredIn: bigint
): Promise<ProfitEstimate> {
  const tokenMeta = getToken(token);
  const vcredAddress = requireTokenAddress('VCRED', CHAIN_ID_HEMI);
  const usdcHemi = requireTokenAddress('USDC', CHAIN_ID_HEMI);
  const usdcEth = requireTokenAddress('USDC', CHAIN_ID_ETHEREUM);
  const tokenHemi = requireTokenAddress(token, CHAIN_ID_HEMI);
  const tokenEth = tokenMeta.addresses[CHAIN_ID_ETHEREUM];

  // Step 1: Quote VCRED -> X on Hemi
  const hemiSwapQuote = await sushiSwapHemi.quoteExactIn(
    clients,
    vcredAddress,
    tokenHemi,
    vcredIn
  );

  if (!hemiSwapQuote) {
    throw new Error(`No Hemi swap quote for ${token}`);
  }

  const xOut = hemiSwapQuote.amountOut;

  // Step 2: Estimate bridge fee (X from Hemi to Ethereum)
  let bridgeFeeOut = 0n;
  if (tokenMeta.bridgeRouteOut === 'STARGATE_LZ') {
    bridgeFeeOut = await stargateHemiToEth.estimateFee(clients, tokenHemi, xOut);
  } else {
    bridgeFeeOut = await hemiTunnelHemiToEth.estimateFee(clients, tokenHemi, xOut);
  }

  // Step 3: Quote X -> USDC on Ethereum
  if (!tokenEth) {
    throw new Error(`Token ${token} not available on Ethereum`);
  }

  const ethSwapQuote = await sushiSwapEthereum.quoteExactIn(
    clients,
    tokenEth,
    usdcEth,
    xOut
  );

  if (!ethSwapQuote) {
    throw new Error(`No Ethereum swap quote for ${token} -> USDC`);
  }

  const usdcOut = ethSwapQuote.amountOut;

  // Step 4: Estimate bridge fee (USDC back to Hemi via Stargate)
  const bridgeFeeBack = await stargateEthToHemi.estimateFee(clients, usdcEth, usdcOut);

  // Step 5: Quote USDC -> VCRED on Hemi (closing swap)
  const closeSwapQuote = await sushiSwapHemi.quoteExactIn(
    clients,
    usdcHemi,
    vcredAddress,
    usdcOut
  );

  if (!closeSwapQuote) {
    throw new Error('No closing swap quote USDC -> VCRED');
  }

  const vcredOut = closeSwapQuote.amountOut;

  // Step 6: Estimate gas costs
  const hemiPublic = getPublicClient(clients, CHAIN_ID_HEMI);
  const ethPublic = getPublicClient(clients, CHAIN_ID_ETHEREUM);

  const hemiGasPrice = await hemiPublic.getGasPrice();
  const ethGasPrice = await ethPublic.getGasPrice();

  // Estimate gas usage
  const hemiSwapGas = 200000n;
  const ethSwapGas = 250000n;
  const bridgeGas = 150000n;

  const gasEstimateHemi = hemiGasPrice * (hemiSwapGas * 2n + bridgeGas); // 2 swaps + bridge init
  const gasEstimateEth = ethGasPrice * (ethSwapGas + bridgeGas); // 1 swap + bridge back

  // Step 7: Convert all fees to VCRED
  // Get VCRED/ETH price for conversion
  const wethHemi = requireTokenAddress('WETH', CHAIN_ID_HEMI);
  let ethToVcredRate = 1000n * 10n ** 18n; // Default: 1 ETH = 1000 VCRED

  try {
    const ethQuote = await sushiSwapHemi.quoteExactIn(
      clients,
      wethHemi,
      vcredAddress,
      10n ** 18n // 1 ETH
    );
    if (ethQuote) {
      ethToVcredRate = ethQuote.amountOut;
    }
  } catch {
    // Use default rate
  }

  // Convert native gas fees to VCRED
  const totalNativeFees = gasEstimateHemi + gasEstimateEth + bridgeFeeOut + bridgeFeeBack;
  const totalFeesVcred = (totalNativeFees * ethToVcredRate) / 10n ** 18n;

  // Calculate profit
  const grossProfitVcred = vcredOut - vcredIn;
  const netProfitVcred = grossProfitVcred - totalFeesVcred;

  diag.debug('Profit estimate', {
    token,
    vcredIn: vcredIn.toString(),
    xOut: xOut.toString(),
    usdcOut: usdcOut.toString(),
    vcredOut: vcredOut.toString(),
    totalFeesVcred: totalFeesVcred.toString(),
    netProfitVcred: netProfitVcred.toString(),
  });

  return {
    token,
    vcredIn,
    xOut,
    usdcOut,
    vcredOut,
    gasEstimateHemi,
    gasEstimateEth,
    bridgeFeeOut,
    bridgeFeeBack,
    totalFeesVcred,
    grossProfitVcred,
    netProfitVcred,
  };
}

// Simple profit calculation for unit testing
export function calculateNetProfit(
  vcredIn: bigint,
  vcredOut: bigint,
  feesVcred: bigint
): bigint {
  return vcredOut - vcredIn - feesVcred;
}

// Convert fee in native ETH to VCRED equivalent
export function convertFeeToVcred(
  feeEth: bigint,
  ethToVcredRate: bigint // How much VCRED per 1 ETH (in wei)
): bigint {
  return (feeEth * ethToVcredRate) / 10n ** 18n;
}
