import { type Clients, getTokenBalance } from '../wallet.js';
import { type Config } from '../config.js';
import { CHAIN_ID_HEMI, CHAIN_ID_ETHEREUM } from '../chains.js';
import { requireTokenAddress, getToken, type TokenId, validateTokenId } from '../tokens.js';
import {
  getActiveCycles,
  createCycle,
  updateCycleState,
  type Cycle,
} from '../db.js';
import { diag, logMoney } from '../logging.js';
import { getBestOpportunity } from './planner.js';
import { findOptimalSize } from './sizing.js';
import {
  executeHemiSwap,
  executeBridgeOut,
  executeEthSwap,
  executeBridgeBack,
  executeCloseSwap,
} from './steps.js';
import { recordCycleCompletion } from './accounting.js';

const MAX_ACTIONS_PER_LOOP = 3;

export interface ReconcilerState {
  running: boolean;
  paused: boolean;
  pausedTokens: Set<TokenId>;
  lastRun: Date | null;
  activeCycles: number;
}

const state: ReconcilerState = {
  running: false,
  paused: false,
  pausedTokens: new Set(),
  lastRun: null,
  activeCycles: 0,
};

export function getReconcilerState(): ReconcilerState {
  return { ...state, pausedTokens: new Set(state.pausedTokens) };
}

export function pauseAll(): void {
  state.paused = true;
  diag.info('Reconciler paused');
}

export function resumeAll(): void {
  state.paused = false;
  diag.info('Reconciler resumed');
}

export function pauseToken(token: TokenId): void {
  state.pausedTokens.add(token);
  diag.info('Token paused', { token });
}

export function resumeToken(token: TokenId): void {
  state.pausedTokens.delete(token);
  diag.info('Token resumed', { token });
}

// Main reconciliation loop iteration
export async function reconcile(clients: Clients, config: Config): Promise<void> {
  if (state.paused) {
    diag.debug('Reconciler paused, skipping');
    return;
  }

  if (state.running) {
    diag.debug('Reconciler already running, skipping');
    return;
  }

  state.running = true;
  state.lastRun = new Date();

  try {
    let actionsThisLoop = 0;

    // Step 1: Process existing active cycles
    const cycles = getActiveCycles();
    state.activeCycles = cycles.length;

    for (const cycle of cycles) {
      if (actionsThisLoop >= MAX_ACTIONS_PER_LOOP) break;
      if (state.pausedTokens.has(validateTokenId(cycle.token))) continue;

      const result = await processStateMachine(clients, config, cycle);
      if (result.actionTaken) {
        actionsThisLoop++;
      }
    }

    // Step 2: Look for new opportunities if we have capacity
    if (actionsThisLoop < MAX_ACTIONS_PER_LOOP && cycles.length < 5) {
      const opportunity = await findNewOpportunity(clients, config);
      if (opportunity) {
        diag.info('New opportunity found', {
          token: opportunity.token,
          vcredIn: opportunity.vcredIn.toString(),
        });
        actionsThisLoop++;
      }
    }
  } catch (err) {
    diag.error('Reconcile error', { error: String(err) });
  } finally {
    state.running = false;
  }
}

interface ProcessResult {
  actionTaken: boolean;
  error?: string;
}

// Process state machine for a single cycle
async function processStateMachine(
  clients: Clients,
  config: Config,
  cycle: Cycle
): Promise<ProcessResult> {
  const token = validateTokenId(cycle.token);

  switch (cycle.state) {
    case 'DETECTED': {
      // Execute first swap: VCRED -> X
      const result = await executeHemiSwap(clients, config, cycle);
      if (result.success && result.newState) {
        updateCycleState(cycle.id, result.newState);
      } else if (!result.success) {
        updateCycleState(cycle.id, 'FAILED', result.error);
      }
      return { actionTaken: true };
    }

    case 'HEMI_SWAP_DONE': {
      // Execute bridge out: X from Hemi -> Ethereum
      const result = await executeBridgeOut(clients, config, cycle);
      if (result.success && result.newState) {
        updateCycleState(cycle.id, result.newState);
      } else if (!result.success) {
        updateCycleState(cycle.id, 'FAILED', result.error);
      }
      return { actionTaken: true };
    }

    case 'BRIDGE_OUT_SENT': {
      // Check if funds arrived on Ethereum
      const arrived = await checkBridgeArrival(clients, cycle, CHAIN_ID_ETHEREUM);
      if (arrived) {
        updateCycleState(cycle.id, 'ON_ETHEREUM');
        return { actionTaken: true };
      }
      return { actionTaken: false };
    }

    case 'BRIDGE_OUT_PROVE_REQUIRED': {
      // Hemi tunnel: need to prove withdrawal
      diag.warn('Cycle requires prove step', { cycleId: cycle.id, token });
      // Prove step needs manual intervention or SDK integration
      return { actionTaken: false };
    }

    case 'BRIDGE_OUT_PROVED': {
      // Check if finalization period has passed
      updateCycleState(cycle.id, 'BRIDGE_OUT_FINALIZE_REQUIRED');
      return { actionTaken: false };
    }

    case 'BRIDGE_OUT_FINALIZE_REQUIRED': {
      // Hemi tunnel: need to finalize withdrawal
      diag.warn('Cycle requires finalize step', { cycleId: cycle.id, token });
      // Finalize step needs manual intervention or SDK integration
      return { actionTaken: false };
    }

    case 'ON_ETHEREUM': {
      // Execute Ethereum swap: X -> USDC
      const result = await executeEthSwap(clients, config, cycle);
      if (result.success && result.newState) {
        updateCycleState(cycle.id, result.newState);
      } else if (!result.success) {
        updateCycleState(cycle.id, 'FAILED', result.error);
      }
      return { actionTaken: true };
    }

    case 'ETH_SWAP_DONE': {
      // Execute bridge back: USDC from Ethereum -> Hemi
      const result = await executeBridgeBack(clients, config, cycle);
      if (result.success && result.newState) {
        updateCycleState(cycle.id, result.newState);
      } else if (!result.success) {
        updateCycleState(cycle.id, 'FAILED', result.error);
      }
      return { actionTaken: true };
    }

    case 'USDC_BRIDGE_BACK_SENT': {
      // Check if USDC arrived on Hemi
      const usdcHemi = requireTokenAddress('USDC', CHAIN_ID_HEMI);
      const balance = await getTokenBalance(clients, CHAIN_ID_HEMI, usdcHemi);
      if (balance > 0n) {
        updateCycleState(cycle.id, 'ON_HEMI_USDC');
        return { actionTaken: true };
      }
      return { actionTaken: false };
    }

    case 'ON_HEMI_USDC': {
      // Execute closing swap: USDC -> VCRED
      const result = await executeCloseSwap(clients, config, cycle);
      if (result.success && result.newState) {
        updateCycleState(cycle.id, result.newState);
      } else if (!result.success) {
        updateCycleState(cycle.id, 'FAILED', result.error);
      }
      return { actionTaken: true };
    }

    case 'HEMI_CLOSE_SWAP_DONE': {
      // Complete the cycle
      updateCycleState(cycle.id, 'COMPLETED');
      recordCycleCompletion({ ...cycle, state: 'COMPLETED' });
      return { actionTaken: true };
    }

    case 'COMPLETED':
    case 'FAILED':
      return { actionTaken: false };

    default:
      diag.warn('Unknown cycle state', { cycleId: cycle.id, state: cycle.state });
      return { actionTaken: false };
  }
}

// Check if bridged funds arrived on destination chain
async function checkBridgeArrival(
  clients: Clients,
  cycle: Cycle,
  destChainId: number
): Promise<boolean> {
  const token = validateTokenId(cycle.token);
  const tokenMeta = getToken(token);
  const tokenAddr = tokenMeta.chains[destChainId]?.address;

  if (!tokenAddr) return false;

  const expectedAmount = BigInt(cycle.xOut ?? '0');
  if (expectedAmount === 0n) return false;

  // Check balance (with some tolerance for bridge fees)
  const balance = await getTokenBalance(clients, destChainId, tokenAddr);
  return balance >= expectedAmount * 95n / 100n;
}

// Find and create a new opportunity
async function findNewOpportunity(
  clients: Clients,
  config: Config
): Promise<{ token: TokenId; vcredIn: bigint } | null> {
  // Get VCRED balance
  const vcredAddress = requireTokenAddress('VCRED', CHAIN_ID_HEMI);
  const vcredBalance = await getTokenBalance(clients, CHAIN_ID_HEMI, vcredAddress);

  if (vcredBalance < config.minSwapVcred) {
    diag.debug('Insufficient VCRED balance', { balance: vcredBalance.toString() });
    return null;
  }

  // Find best opportunity
  const opportunity = await getBestOpportunity(clients, config);
  if (!opportunity) {
    diag.debug('No opportunities found');
    return null;
  }

  if (state.pausedTokens.has(opportunity.token)) {
    diag.debug('Best opportunity token is paused', { token: opportunity.token });
    return null;
  }

  // Find optimal size
  const sizing = await findOptimalSize(clients, config, opportunity.token, vcredBalance);
  if (!sizing) {
    diag.debug('Could not find profitable size', { token: opportunity.token });
    return null;
  }

  // Create new cycle
  const cycle = createCycle(opportunity.token, sizing.optimalVcredIn);

  logMoney('CYCLE_CREATED', {
    cycleId: cycle.id,
    token: opportunity.token,
    vcredIn: sizing.optimalVcredIn.toString(),
    hemiOut: sizing.hemiAmountOut.toString(),
    ethRefOut: sizing.ethRefAmountOut.toString(),
  });

  return {
    token: opportunity.token,
    vcredIn: sizing.optimalVcredIn,
  };
}

// Start the reconciler loop
export function startReconciler(
  clients: Clients,
  config: Config
): NodeJS.Timeout {
  diag.info('Starting reconciler', { intervalMs: config.reconcileIntervalMs });

  // Run immediately
  reconcile(clients, config);

  // Then run on interval
  return setInterval(() => {
    reconcile(clients, config);
  }, config.reconcileIntervalMs);
}

export function stopReconciler(timer: NodeJS.Timeout): void {
  clearInterval(timer);
  diag.info('Reconciler stopped');
}
