import { type Clients, getPublicClient, getTokenBalance } from '../wallet.js';
import { type Config } from '../config.js';
import { CHAIN_ID_HEMI, CHAIN_ID_ETHEREUM } from '../chains.js';
import { requireTokenAddress, getToken, validateTokenId } from '../tokens.js';
import { getBestSwapQuote, executeSwap } from '../providers/swapAggregator.js';
import { stargateHemiToEth, stargateEthToHemi } from '../providers/stargateBridge.js';
import { hemiTunnelHemiToEth } from '../providers/hemiTunnel.js';
import { type Cycle, createStep, updateStep, updateCycleAmounts, type CycleState, getStepsForCycle } from '../db.js';
import { diag, logMoney } from '../logging.js';

export interface StepResult {
  success: boolean;
  txHash?: `0x${string}`;
  error?: string;
  newState?: CycleState;
}

// Execute Hemi swap: VCRED -> X
export async function executeHemiSwap(
  clients: Clients,
  config: Config,
  cycle: Cycle
): Promise<StepResult> {
  const token = validateTokenId(cycle.token);
  const vcredIn = BigInt(cycle.vcredIn);
  const vcredAddress = requireTokenAddress('VCRED', CHAIN_ID_HEMI);
  const tokenAddress = requireTokenAddress(token, CHAIN_ID_HEMI);

  // Check if already done by looking at balance
  const tokenBalance = await getTokenBalance(clients, CHAIN_ID_HEMI, tokenAddress);
  if (cycle.xOut && tokenBalance >= BigInt(cycle.xOut) * 95n / 100n) {
    diag.info('Hemi swap already completed', { cycleId: cycle.id });
    return { success: true, newState: 'HEMI_SWAP_DONE' };
  }

  try {
    // Get best quote from all providers
    const quote = await getBestSwapQuote(clients, CHAIN_ID_HEMI, vcredAddress, tokenAddress, vcredIn);
    if (!quote) {
      return { success: false, error: 'No swap quote available' };
    }

    // Execute swap (includes approval + simulation)
    const step = createStep(cycle.id, 'HEMI_SWAP', CHAIN_ID_HEMI);
    const txHash = await executeSwap(clients, quote);
    updateStep(step.id, { txHash, status: 'submitted' });

    // Wait for confirmation with timeout
    const publicClient = getPublicClient(clients, CHAIN_ID_HEMI);
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 120_000 });

    if (receipt.status === 'reverted') {
      updateStep(step.id, { status: 'failed', error: 'Transaction reverted' });
      return { success: false, txHash, error: 'Transaction reverted' };
    }

    updateStep(step.id, {
      status: 'confirmed',
      gasUsed: receipt.gasUsed,
      gasPrice: receipt.effectiveGasPrice,
    });

    // Get actual output
    const newBalance = await getTokenBalance(clients, CHAIN_ID_HEMI, tokenAddress);
    const xOut = newBalance - tokenBalance;
    updateCycleAmounts(cycle.id, { xOut });

    logMoney('HEMI_SWAP', {
      cycleId: cycle.id,
      token,
      vcredIn: vcredIn.toString(),
      xOut: xOut.toString(),
      txHash,
    });

    return { success: true, txHash, newState: 'HEMI_SWAP_DONE' };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

// Execute bridge: X from Hemi -> Ethereum
export async function executeBridgeOut(
  clients: Clients,
  config: Config,
  cycle: Cycle
): Promise<StepResult> {
  const token = validateTokenId(cycle.token);
  const tokenMeta = getToken(token);
  const tokenAddress = requireTokenAddress(token, CHAIN_ID_HEMI);
  const amount = BigInt(cycle.xOut ?? '0');

  if (amount === 0n) {
    return { success: false, error: 'No amount to bridge' };
  }

  try {
    const isHemiTunnel = tokenMeta.bridgeRouteOut === 'HEMI_TUNNEL';
    const bridge = isHemiTunnel ? hemiTunnelHemiToEth : stargateHemiToEth;

    const step = createStep(cycle.id, 'BRIDGE_OUT', CHAIN_ID_HEMI);
    const bridgeTx = await bridge.send(clients, tokenAddress, amount, clients.address);

    updateStep(step.id, { txHash: bridgeTx.txHash, status: 'submitted' });

    // Hemi tunnel send() waits internally and returns status; Stargate does not
    if (bridgeTx.status === 'failed') {
      updateStep(step.id, { status: 'failed', error: 'Transaction reverted' });
      return { success: false, txHash: bridgeTx.txHash, error: 'Transaction reverted' };
    }

    // For Stargate, wait for source tx confirmation
    if (!isHemiTunnel) {
      const publicClient = getPublicClient(clients, CHAIN_ID_HEMI);
      const receipt = await publicClient.waitForTransactionReceipt({ hash: bridgeTx.txHash, timeout: 120_000 });

      if (receipt.status === 'reverted') {
        updateStep(step.id, { status: 'failed', error: 'Transaction reverted' });
        return { success: false, txHash: bridgeTx.txHash, error: 'Transaction reverted' };
      }

      updateStep(step.id, {
        status: 'confirmed',
        gasUsed: receipt.gasUsed,
        gasPrice: receipt.effectiveGasPrice,
      });
    } else {
      // Hemi tunnel already confirmed in send(), store withdrawalHash
      updateStep(step.id, {
        status: 'confirmed',
        withdrawalHash: bridgeTx.withdrawalHash,
      });
    }

    logMoney('BRIDGE_OUT', {
      cycleId: cycle.id,
      token,
      amount: amount.toString(),
      provider: bridge.name,
      txHash: bridgeTx.txHash,
    });

    // Determine next state based on bridge type
    const nextState: CycleState = isHemiTunnel
      ? 'BRIDGE_OUT_PROVE_REQUIRED'
      : 'BRIDGE_OUT_SENT';

    return { success: true, txHash: bridgeTx.txHash, newState: nextState };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

// Execute Ethereum swap: X -> USDC
export async function executeEthSwap(
  clients: Clients,
  config: Config,
  cycle: Cycle
): Promise<StepResult> {
  const token = validateTokenId(cycle.token);
  const tokenMeta = getToken(token);
  const tokenEth = tokenMeta.chains[CHAIN_ID_ETHEREUM]?.address;
  const usdcEth = requireTokenAddress('USDC', CHAIN_ID_ETHEREUM);

  if (!tokenEth) {
    return { success: false, error: 'Token not available on Ethereum' };
  }

  // Get current balance of token on Ethereum
  const tokenBalance = await getTokenBalance(clients, CHAIN_ID_ETHEREUM, tokenEth);
  if (tokenBalance === 0n) {
    return { success: false, error: 'No token balance on Ethereum' };
  }

  // Check if already done
  const usdcBalance = await getTokenBalance(clients, CHAIN_ID_ETHEREUM, usdcEth);
  if (cycle.usdcOut && usdcBalance >= BigInt(cycle.usdcOut) * 95n / 100n) {
    diag.info('Ethereum swap already completed', { cycleId: cycle.id });
    return { success: true, newState: 'ETH_SWAP_DONE' };
  }

  try {
    // Get best quote from all providers
    const quote = await getBestSwapQuote(clients, CHAIN_ID_ETHEREUM, tokenEth, usdcEth, tokenBalance);
    if (!quote) {
      return { success: false, error: 'No swap quote available' };
    }

    // Execute swap (includes approval + simulation)
    const step = createStep(cycle.id, 'ETH_SWAP', CHAIN_ID_ETHEREUM);
    const txHash = await executeSwap(clients, quote);
    updateStep(step.id, { txHash, status: 'submitted' });

    const publicClient = getPublicClient(clients, CHAIN_ID_ETHEREUM);
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 120_000 });

    if (receipt.status === 'reverted') {
      updateStep(step.id, { status: 'failed', error: 'Transaction reverted' });
      return { success: false, txHash, error: 'Transaction reverted' };
    }

    updateStep(step.id, {
      status: 'confirmed',
      gasUsed: receipt.gasUsed,
      gasPrice: receipt.effectiveGasPrice,
    });

    const newUsdcBalance = await getTokenBalance(clients, CHAIN_ID_ETHEREUM, usdcEth);
    const usdcOut = newUsdcBalance - usdcBalance;
    updateCycleAmounts(cycle.id, { usdcOut });

    logMoney('ETH_SWAP', {
      cycleId: cycle.id,
      token,
      tokenIn: tokenBalance.toString(),
      usdcOut: usdcOut.toString(),
      txHash,
    });

    return { success: true, txHash, newState: 'ETH_SWAP_DONE' };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

// Execute bridge: USDC from Ethereum -> Hemi
export async function executeBridgeBack(
  clients: Clients,
  config: Config,
  cycle: Cycle
): Promise<StepResult> {
  const usdcEth = requireTokenAddress('USDC', CHAIN_ID_ETHEREUM);
  const usdcBalance = await getTokenBalance(clients, CHAIN_ID_ETHEREUM, usdcEth);

  if (usdcBalance === 0n) {
    return { success: false, error: 'No USDC to bridge back' };
  }

  try {
    const step = createStep(cycle.id, 'BRIDGE_BACK', CHAIN_ID_ETHEREUM);
    const bridgeTx = await stargateEthToHemi.send(clients, usdcEth, usdcBalance, clients.address);

    updateStep(step.id, { txHash: bridgeTx.txHash, status: 'submitted' });

    const publicClient = getPublicClient(clients, CHAIN_ID_ETHEREUM);
    const receipt = await publicClient.waitForTransactionReceipt({ hash: bridgeTx.txHash, timeout: 120_000 });

    if (receipt.status === 'reverted') {
      updateStep(step.id, { status: 'failed', error: 'Transaction reverted' });
      return { success: false, txHash: bridgeTx.txHash, error: 'Transaction reverted' };
    }

    updateStep(step.id, {
      status: 'confirmed',
      gasUsed: receipt.gasUsed,
      gasPrice: receipt.effectiveGasPrice,
    });

    logMoney('BRIDGE_BACK', {
      cycleId: cycle.id,
      amount: usdcBalance.toString(),
      txHash: bridgeTx.txHash,
    });

    return { success: true, txHash: bridgeTx.txHash, newState: 'USDC_BRIDGE_BACK_SENT' };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

// Execute closing swap: USDC -> VCRED on Hemi
export async function executeCloseSwap(
  clients: Clients,
  config: Config,
  cycle: Cycle
): Promise<StepResult> {
  const usdcHemi = requireTokenAddress('USDC', CHAIN_ID_HEMI);
  const vcredAddress = requireTokenAddress('VCRED', CHAIN_ID_HEMI);

  const usdcBalance = await getTokenBalance(clients, CHAIN_ID_HEMI, usdcHemi);
  if (usdcBalance === 0n) {
    return { success: false, error: 'No USDC on Hemi to swap' };
  }

  // Check if already done
  const vcredBefore = await getTokenBalance(clients, CHAIN_ID_HEMI, vcredAddress);

  try {
    // Get best quote from all providers
    const quote = await getBestSwapQuote(clients, CHAIN_ID_HEMI, usdcHemi, vcredAddress, usdcBalance);
    if (!quote) {
      return { success: false, error: 'No swap quote available' };
    }

    // Execute swap (includes approval + simulation)
    const step = createStep(cycle.id, 'CLOSE_SWAP', CHAIN_ID_HEMI);
    const txHash = await executeSwap(clients, quote);
    updateStep(step.id, { txHash, status: 'submitted' });

    const publicClient = getPublicClient(clients, CHAIN_ID_HEMI);
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 120_000 });

    if (receipt.status === 'reverted') {
      updateStep(step.id, { status: 'failed', error: 'Transaction reverted' });
      return { success: false, txHash, error: 'Transaction reverted' };
    }

    updateStep(step.id, {
      status: 'confirmed',
      gasUsed: receipt.gasUsed,
      gasPrice: receipt.effectiveGasPrice,
    });

    const vcredAfter = await getTokenBalance(clients, CHAIN_ID_HEMI, vcredAddress);
    const vcredOut = vcredAfter - vcredBefore;
    updateCycleAmounts(cycle.id, { vcredOut });

    logMoney('CLOSE_SWAP', {
      cycleId: cycle.id,
      usdcIn: usdcBalance.toString(),
      vcredOut: vcredOut.toString(),
      txHash,
    });

    return { success: true, txHash, newState: 'HEMI_CLOSE_SWAP_DONE' };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

// Helper to retrieve withdrawalHash for a cycle's BRIDGE_OUT step
export function getWithdrawalHashForCycle(cycleId: number): string | null {
  const steps = getStepsForCycle(cycleId);
  const bridgeOut = steps.find(s => s.stepType === 'BRIDGE_OUT');
  return bridgeOut?.withdrawalHash ?? null;
}
