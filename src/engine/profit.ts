import { type Clients, getPublicClient } from '../wallet.js';
import { type Config } from '../config.js';
import { CHAIN_ID_HEMI, CHAIN_ID_ETHEREUM } from '../chains.js';
import { type TokenId, requireTokenAddress, getToken, requireTokenDecimals } from '../tokens.js';
import { getBestSwapQuote } from '../providers/swapAggregator.js';
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
  const tokenEth = tokenMeta.chains[CHAIN_ID_ETHEREUM]?.address;
  const wethHemi = requireTokenAddress('WETH', CHAIN_ID_HEMI);

  if (!tokenEth) {
    throw new Error(`Token ${token} not available on Ethereum`);
  }

  const hemiPublic = getPublicClient(clients, CHAIN_ID_HEMI);
  const ethPublic = getPublicClient(clients, CHAIN_ID_ETHEREUM);

  // Group 1: First swap + gas prices + ETH/VCRED rate (all independent)
  const vcredDecimals = requireTokenDecimals('VCRED', CHAIN_ID_HEMI);
  const [hemiSwapQuote, hemiGasPrice, ethGasPrice, ethToVcredQuote] = await Promise.all([
    getBestSwapQuote(clients, CHAIN_ID_HEMI, vcredAddress, tokenHemi, vcredIn),
    hemiPublic.getGasPrice(),
    ethPublic.getGasPrice(),
    getBestSwapQuote(clients, CHAIN_ID_HEMI, wethHemi, vcredAddress, 10n ** 18n).catch(() => null),
  ]);

  if (!hemiSwapQuote) {
    throw new Error(`No Hemi swap quote for ${token}`);
  }

  const xOut = hemiSwapQuote.amountOut;
  // Default ETH to VCRED rate: 1 ETH = 1000 VCRED
  const ethToVcredRate = ethToVcredQuote?.amountOut ?? (1000n * (10n ** BigInt(vcredDecimals)));

  // Group 2: Bridge fee + ETH swap (both need xOut)
  const bridgeFeeOutPromise = tokenMeta.bridgeRouteOut === 'STARGATE_LZ'
    ? stargateHemiToEth.estimateFee(clients, tokenHemi, xOut)
    : hemiTunnelHemiToEth.estimateFee(clients, tokenHemi, xOut);

  const [bridgeFeeOut, ethSwapQuote] = await Promise.all([
    bridgeFeeOutPromise,
    getBestSwapQuote(clients, CHAIN_ID_ETHEREUM, tokenEth, usdcEth, xOut),
  ]);

  if (!ethSwapQuote) {
    throw new Error(`No Ethereum swap quote for ${token} -> USDC`);
  }

  const usdcOut = ethSwapQuote.amountOut;

  // Group 3: Bridge back + close swap (both need usdcOut)
  const [bridgeFeeBack, closeSwapQuote] = await Promise.all([
    stargateEthToHemi.estimateFee(clients, usdcEth, usdcOut),
    getBestSwapQuote(clients, CHAIN_ID_HEMI, usdcHemi, vcredAddress, usdcOut),
  ]);

  if (!closeSwapQuote) {
    throw new Error('No closing swap quote USDC -> VCRED');
  }

  const vcredOut = closeSwapQuote.amountOut;

  // Calculate gas estimates
  const hemiSwapGas = 200000n;
  const ethSwapGas = 250000n;
  const bridgeGas = 150000n;

  const gasEstimateHemi = hemiGasPrice * (hemiSwapGas * 2n + bridgeGas); // 2 swaps + bridge init
  const gasEstimateEth = ethGasPrice * (ethSwapGas + bridgeGas); // 1 swap + bridge back

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
// ethToVcredRate is how much VCRED you get for 1 ETH (18 decimals)
// Result is in VCRED's native decimals
export function convertFeeToVcred(
  feeEth: bigint,
  ethToVcredRate: bigint
): bigint {
  return (feeEth * ethToVcredRate) / 10n ** 18n;
}
