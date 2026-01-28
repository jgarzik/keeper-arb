import { type Clients, getPublicClient, getTokenBalance } from '../wallet.js';
import { type Config } from '../config.js';
import { CHAIN_ID_HEMI, CHAIN_ID_ETHEREUM } from '../chains.js';
import { requireTokenAddress, getToken, validateTokenId } from '../tokens.js';
import { getBestSwapQuote, executeSwap } from '../providers/swapAggregator.js';
import { stargateHemiToEth, stargateEthToHemi } from '../providers/stargateBridge.js';
import { hemiTunnelHemiToEth } from '../providers/hemiTunnel.js';
import { type Cycle, type Step, createStep, updateStep, updateCycleAmounts, type CycleState, getStepsForCycle } from '../db.js';
import { diag, logMoney } from '../logging.js';

// Find existing non-failed step or create new one (idempotent step creation)
function getOrCreateStep(cycleId: number, stepType: string, chainId: number): Step {
  const steps = getStepsForCycle(cycleId);
  const existing = steps.find(s => s.stepType === stepType && s.status !== 'failed');
  if (existing) {
    return existing;
  }
  return createStep(cycleId, stepType, chainId);
}

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
    const step = getOrCreateStep(cycle.id, 'HEMI_SWAP', CHAIN_ID_HEMI);
    if (step.status === 'confirmed') {
      return { success: true, txHash: step.txHash as `0x${string}`, newState: 'HEMI_SWAP_DONE' };
    }
    const txHash = await executeSwap(clients, quote);
    updateStep(step.id, { txHash, status: 'submitted' });

    // Wait for confirmation with timeout
    const publicClient = getPublicClient(clients, CHAIN_ID_HEMI);
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 120_000 });

    if (receipt.status !== 'success') {
      updateStep(step.id, { status: 'failed', error: `Transaction failed: ${receipt.status}` });
      return { success: false, txHash, error: `Transaction failed: ${receipt.status}` };
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
      chainId: CHAIN_ID_HEMI,
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

    const step = getOrCreateStep(cycle.id, 'BRIDGE_OUT', CHAIN_ID_HEMI);
    if (step.status === 'confirmed') {
      const nextState: CycleState = isHemiTunnel ? 'BRIDGE_OUT_PROVE_REQUIRED' : 'BRIDGE_OUT_SENT';
      return { success: true, txHash: step.txHash as `0x${string}`, newState: nextState };
    }
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

      if (receipt.status !== 'success') {
        updateStep(step.id, { status: 'failed', error: `Transaction failed: ${receipt.status}` });
        return { success: false, txHash: bridgeTx.txHash, error: `Transaction failed: ${receipt.status}` };
      }

      updateStep(step.id, {
        status: 'confirmed',
        gasUsed: receipt.gasUsed,
        gasPrice: receipt.effectiveGasPrice,
        lzGuid: bridgeTx.lzGuid,
      });
    } else {
      // Hemi tunnel already confirmed in send(), store withdrawalHash and withdrawalData
      updateStep(step.id, {
        status: 'confirmed',
        withdrawalHash: bridgeTx.withdrawalHash,
        withdrawalData: bridgeTx.withdrawalData,
      });
    }

    logMoney('BRIDGE_OUT', {
      cycleId: cycle.id,
      token,
      amount: amount.toString(),
      provider: bridge.name,
      txHash: bridgeTx.txHash,
      lzGuid: bridgeTx.lzGuid,
      chainId: CHAIN_ID_HEMI,
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
    const step = getOrCreateStep(cycle.id, 'ETH_SWAP', CHAIN_ID_ETHEREUM);
    if (step.status === 'confirmed') {
      return { success: true, txHash: step.txHash as `0x${string}`, newState: 'ETH_SWAP_DONE' };
    }
    const txHash = await executeSwap(clients, quote);
    updateStep(step.id, { txHash, status: 'submitted' });

    const publicClient = getPublicClient(clients, CHAIN_ID_ETHEREUM);
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 120_000 });

    if (receipt.status !== 'success') {
      updateStep(step.id, { status: 'failed', error: `Transaction failed: ${receipt.status}` });
      return { success: false, txHash, error: `Transaction failed: ${receipt.status}` };
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
      chainId: CHAIN_ID_ETHEREUM,
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
    const step = getOrCreateStep(cycle.id, 'BRIDGE_BACK', CHAIN_ID_ETHEREUM);
    if (step.status === 'confirmed') {
      return { success: true, txHash: step.txHash as `0x${string}`, newState: 'USDC_BRIDGE_BACK_SENT' };
    }
    const bridgeTx = await stargateEthToHemi.send(clients, usdcEth, usdcBalance, clients.address);

    updateStep(step.id, { txHash: bridgeTx.txHash, status: 'submitted' });

    const publicClient = getPublicClient(clients, CHAIN_ID_ETHEREUM);
    const receipt = await publicClient.waitForTransactionReceipt({ hash: bridgeTx.txHash, timeout: 120_000 });

    if (receipt.status !== 'success') {
      updateStep(step.id, { status: 'failed', error: `Transaction failed: ${receipt.status}` });
      return { success: false, txHash: bridgeTx.txHash, error: `Transaction failed: ${receipt.status}` };
    }

    updateStep(step.id, {
      status: 'confirmed',
      gasUsed: receipt.gasUsed,
      gasPrice: receipt.effectiveGasPrice,
      lzGuid: bridgeTx.lzGuid,
    });

    logMoney('BRIDGE_BACK', {
      cycleId: cycle.id,
      token: 'USDC',
      amount: usdcBalance.toString(),
      txHash: bridgeTx.txHash,
      lzGuid: bridgeTx.lzGuid,
      chainId: CHAIN_ID_ETHEREUM,
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
    const step = getOrCreateStep(cycle.id, 'CLOSE_SWAP', CHAIN_ID_HEMI);
    if (step.status === 'confirmed') {
      return { success: true, txHash: step.txHash as `0x${string}`, newState: 'HEMI_CLOSE_SWAP_DONE' };
    }
    const txHash = await executeSwap(clients, quote);
    updateStep(step.id, { txHash, status: 'submitted' });

    const publicClient = getPublicClient(clients, CHAIN_ID_HEMI);
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 120_000 });

    if (receipt.status !== 'success') {
      updateStep(step.id, { status: 'failed', error: `Transaction failed: ${receipt.status}` });
      return { success: false, txHash, error: `Transaction failed: ${receipt.status}` };
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
      token: 'VCRED',
      usdcIn: usdcBalance.toString(),
      vcredOut: vcredOut.toString(),
      txHash,
      chainId: CHAIN_ID_HEMI,
    });

    return { success: true, txHash, newState: 'HEMI_CLOSE_SWAP_DONE' };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

// Execute Hemi tunnel prove withdrawal
export async function executeProveWithdrawal(
  clients: Clients,
  _config: Config,
  cycle: Cycle
): Promise<StepResult> {
  const token = validateTokenId(cycle.token);
  const tokenAddress = requireTokenAddress(token, CHAIN_ID_HEMI);

  // Get the BRIDGE_OUT step to retrieve txHash
  const steps = getStepsForCycle(cycle.id);
  const bridgeOutStep = steps.find(s => s.stepType === 'BRIDGE_OUT');

  if (!bridgeOutStep?.txHash) {
    return { success: false, error: 'No BRIDGE_OUT step found with txHash' };
  }

  try {
    const step = getOrCreateStep(cycle.id, 'BRIDGE_PROVE', CHAIN_ID_ETHEREUM);
    if (step.status === 'confirmed') {
      return { success: true, txHash: step.txHash as `0x${string}`, newState: 'BRIDGE_OUT_PROVED' };
    }

    // Build BridgeTransaction from cycle data
    const bridgeTx = {
      provider: 'HemiTunnel',
      fromChainId: CHAIN_ID_HEMI,
      toChainId: CHAIN_ID_ETHEREUM,
      token: tokenAddress,
      amount: BigInt(cycle.xOut ?? '0'),
      txHash: bridgeOutStep.txHash as `0x${string}`,
      status: 'prove_required' as const,
      withdrawalHash: bridgeOutStep.withdrawalHash as `0x${string}` | undefined,
      withdrawalData: bridgeOutStep.withdrawalData ?? undefined,
    };

    const hash = await hemiTunnelHemiToEth.prove!(clients, bridgeTx);
    updateStep(step.id, { txHash: hash, status: 'submitted' });

    // Wait for confirmation
    const publicClient = getPublicClient(clients, CHAIN_ID_ETHEREUM);
    const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });

    if (receipt.status !== 'success') {
      updateStep(step.id, { status: 'failed', error: `Transaction failed: ${receipt.status}` });
      return { success: false, txHash: hash, error: `Prove transaction failed: ${receipt.status}` };
    }

    updateStep(step.id, {
      status: 'confirmed',
      gasUsed: receipt.gasUsed,
      gasPrice: receipt.effectiveGasPrice,
    });

    logMoney('BRIDGE_PROVE', {
      cycleId: cycle.id,
      token,
      txHash: hash,
      chainId: CHAIN_ID_ETHEREUM,
    });

    return { success: true, txHash: hash, newState: 'BRIDGE_OUT_PROVED' };
  } catch (err) {
    const errStr = String(err);
    // L2 output not ready is expected - log at debug and retry later
    if (errStr.includes('L2_OUTPUT_NOT_READY')) {
      diag.debug('L2 output not ready, will retry', { cycleId: cycle.id, token });
      return { success: false };
    }
    diag.error('Prove withdrawal failed', { cycleId: cycle.id, error: errStr });
    return { success: false, error: errStr };
  }
}

// Execute Hemi tunnel finalize withdrawal
export async function executeFinalizeWithdrawal(
  clients: Clients,
  _config: Config,
  cycle: Cycle
): Promise<StepResult> {
  const token = validateTokenId(cycle.token);
  const tokenAddress = requireTokenAddress(token, CHAIN_ID_HEMI);

  // Get the BRIDGE_OUT step to retrieve txHash
  const steps = getStepsForCycle(cycle.id);
  const bridgeOutStep = steps.find(s => s.stepType === 'BRIDGE_OUT');

  if (!bridgeOutStep?.txHash) {
    return { success: false, error: 'No BRIDGE_OUT step found with txHash' };
  }

  try {
    const step = getOrCreateStep(cycle.id, 'BRIDGE_FINALIZE', CHAIN_ID_ETHEREUM);
    if (step.status === 'confirmed') {
      return { success: true, txHash: step.txHash as `0x${string}`, newState: 'ON_ETHEREUM' };
    }

    // Build BridgeTransaction from cycle data
    const bridgeTx = {
      provider: 'HemiTunnel',
      fromChainId: CHAIN_ID_HEMI,
      toChainId: CHAIN_ID_ETHEREUM,
      token: tokenAddress,
      amount: BigInt(cycle.xOut ?? '0'),
      txHash: bridgeOutStep.txHash as `0x${string}`,
      status: 'finalize_required' as const,
      withdrawalHash: bridgeOutStep.withdrawalHash as `0x${string}` | undefined,
      withdrawalData: bridgeOutStep.withdrawalData ?? undefined,
    };

    const hash = await hemiTunnelHemiToEth.finalize!(clients, bridgeTx);
    updateStep(step.id, { txHash: hash, status: 'submitted' });

    // Wait for confirmation
    const publicClient = getPublicClient(clients, CHAIN_ID_ETHEREUM);
    const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });

    if (receipt.status !== 'success') {
      updateStep(step.id, { status: 'failed', error: `Transaction failed: ${receipt.status}` });
      return { success: false, txHash: hash, error: `Finalize transaction failed: ${receipt.status}` };
    }

    updateStep(step.id, {
      status: 'confirmed',
      gasUsed: receipt.gasUsed,
      gasPrice: receipt.effectiveGasPrice,
    });

    logMoney('BRIDGE_FINALIZE', {
      cycleId: cycle.id,
      token,
      txHash: hash,
      chainId: CHAIN_ID_ETHEREUM,
    });

    return { success: true, txHash: hash, newState: 'ON_ETHEREUM' };
  } catch (err) {
    diag.error('Finalize withdrawal failed', { cycleId: cycle.id, error: String(err) });
    return { success: false, error: String(err) };
  }
}

// Check if the challenge period has passed for a proved withdrawal
export async function checkFinalizationReady(
  clients: Clients,
  cycle: Cycle
): Promise<boolean> {
  const steps = getStepsForCycle(cycle.id);
  const proveStep = steps.find(s => s.stepType === 'BRIDGE_PROVE' && s.status === 'confirmed');

  if (!proveStep) {
    return false;
  }

  // Get the prove timestamp from the provenWithdrawals mapping
  const bridgeOutStep = steps.find(s => s.stepType === 'BRIDGE_OUT');
  if (!bridgeOutStep?.withdrawalHash) {
    return false;
  }

  try {
    const publicClient = getPublicClient(clients, CHAIN_ID_ETHEREUM);
    const proven = await publicClient.readContract({
      address: '0x39a0005415256B9863aFE2d55Edcf75ECc3A4D7e' as const, // HEMI_OPTIMISM_PORTAL
      abi: [
        {
          name: 'provenWithdrawals',
          type: 'function',
          stateMutability: 'view',
          inputs: [{ name: '_withdrawalHash', type: 'bytes32' }],
          outputs: [
            { name: 'outputRoot', type: 'bytes32' },
            { name: 'timestamp', type: 'uint128' },
            { name: 'l2OutputIndex', type: 'uint128' },
          ],
        },
      ] as const,
      functionName: 'provenWithdrawals',
      args: [bridgeOutStep.withdrawalHash as `0x${string}`],
    }) as readonly [string, bigint, bigint];

    const timestamp = proven[1];
    if (timestamp === 0n) {
      return false;
    }

    const now = BigInt(Math.floor(Date.now() / 1000));
    const challengePeriod = 86400n; // 1 day for Hemi

    return now >= timestamp + challengePeriod;
  } catch (err) {
    diag.warn('Failed to check finalization readiness', { cycleId: cycle.id, error: String(err) });
    return false;
  }
}

// Helper to retrieve withdrawalHash for a cycle's BRIDGE_OUT step
export function getWithdrawalHashForCycle(cycleId: number): string | null {
  const steps = getStepsForCycle(cycleId);
  const bridgeOut = steps.find(s => s.stepType === 'BRIDGE_OUT');
  return bridgeOut?.withdrawalHash ?? null;
}
