import { type Cycle, getRecentCycles, getStepsForCycle, addLedgerEntry } from '../db.js';
import { CHAIN_ID_HEMI, CHAIN_ID_ETHEREUM } from '../chains.js';
import { logMoney } from '../logging.js';

export interface CyclePnL {
  cycleId: number;
  token: string;
  vcredIn: bigint;
  vcredOut: bigint;
  grossProfit: bigint;
  totalGasHemi: bigint;
  totalGasEth: bigint;
  netProfit: bigint;
  completedAt: string;
}

export interface DailyPnL {
  date: string;
  cyclesCompleted: number;
  totalVcredSold: bigint;
  totalVcredRegained: bigint;
  grossProfit: bigint;
  totalGasHemi: bigint;
  totalGasEth: bigint;
  netProfit: bigint;
}

export interface LifetimePnL {
  cyclesCompleted: number;
  cyclesFailed: number;
  totalVcredSold: bigint;
  totalVcredRegained: bigint;
  grossProfit: bigint;
  totalGasHemi: bigint;
  totalGasEth: bigint;
  netProfit: bigint;
}

// Calculate P&L for a completed cycle
export function calculateCyclePnL(cycle: Cycle): CyclePnL | null {
  if (cycle.state !== 'COMPLETED' || !cycle.vcredOut) {
    return null;
  }

  const vcredIn = BigInt(cycle.vcredIn);
  const vcredOut = BigInt(cycle.vcredOut);
  const grossProfit = vcredOut - vcredIn;

  // Get gas costs from steps
  const steps = getStepsForCycle(cycle.id);
  let totalGasHemi = 0n;
  let totalGasEth = 0n;

  for (const step of steps) {
    if (step.gasUsed && step.gasPrice) {
      const gasCost = BigInt(step.gasUsed) * BigInt(step.gasPrice);
      if (step.chainId === CHAIN_ID_HEMI) {
        totalGasHemi += gasCost;
      } else if (step.chainId === CHAIN_ID_ETHEREUM) {
        totalGasEth += gasCost;
      }
    }
  }

  // Net profit (simplified - doesn't account for ETH/VCRED conversion)
  // In production, should convert gas costs to VCRED
  const netProfit = grossProfit; // Simplified

  return {
    cycleId: cycle.id,
    token: cycle.token,
    vcredIn,
    vcredOut,
    grossProfit,
    totalGasHemi,
    totalGasEth,
    netProfit,
    completedAt: cycle.updatedAt,
  };
}

// Aggregate P&L for a specific date
export function calculateDailyPnL(date: string): DailyPnL {
  const cycles = getRecentCycles(1000);
  const dayCycles = cycles.filter(
    (c) => c.state === 'COMPLETED' && c.updatedAt.startsWith(date)
  );

  let totalVcredSold = 0n;
  let totalVcredRegained = 0n;
  let grossProfit = 0n;
  let totalGasHemi = 0n;
  let totalGasEth = 0n;

  for (const cycle of dayCycles) {
    const pnl = calculateCyclePnL(cycle);
    if (pnl) {
      totalVcredSold += pnl.vcredIn;
      totalVcredRegained += pnl.vcredOut;
      grossProfit += pnl.grossProfit;
      totalGasHemi += pnl.totalGasHemi;
      totalGasEth += pnl.totalGasEth;
    }
  }

  return {
    date,
    cyclesCompleted: dayCycles.length,
    totalVcredSold,
    totalVcredRegained,
    grossProfit,
    totalGasHemi,
    totalGasEth,
    netProfit: grossProfit, // Simplified
  };
}

// Calculate lifetime P&L
export function calculateLifetimePnL(): LifetimePnL {
  const cycles = getRecentCycles(10000);

  let cyclesCompleted = 0;
  let cyclesFailed = 0;
  let totalVcredSold = 0n;
  let totalVcredRegained = 0n;
  let grossProfit = 0n;
  let totalGasHemi = 0n;
  let totalGasEth = 0n;

  for (const cycle of cycles) {
    if (cycle.state === 'COMPLETED') {
      cyclesCompleted++;
      const pnl = calculateCyclePnL(cycle);
      if (pnl) {
        totalVcredSold += pnl.vcredIn;
        totalVcredRegained += pnl.vcredOut;
        grossProfit += pnl.grossProfit;
        totalGasHemi += pnl.totalGasHemi;
        totalGasEth += pnl.totalGasEth;
      }
    } else if (cycle.state === 'FAILED') {
      cyclesFailed++;
    }
  }

  return {
    cyclesCompleted,
    cyclesFailed,
    totalVcredSold,
    totalVcredRegained,
    grossProfit,
    totalGasHemi,
    totalGasEth,
    netProfit: grossProfit, // Simplified
  };
}

// Record a gas expenditure in the ledger
export function recordGasExpenditure(
  cycleId: number,
  stepId: number,
  chainId: number,
  gasUsed: bigint,
  gasPrice: bigint,
  txHash: string
): void {
  const gasCost = gasUsed * gasPrice;
  addLedgerEntry('GAS', chainId, 'ETH', gasCost, cycleId, stepId, txHash);
}

// Record completed cycle P&L
export function recordCycleCompletion(cycle: Cycle): void {
  const pnl = calculateCyclePnL(cycle);
  if (pnl) {
    logMoney('CYCLE_COMPLETE', {
      cycleId: pnl.cycleId,
      token: pnl.token,
      vcredIn: pnl.vcredIn.toString(),
      vcredOut: pnl.vcredOut.toString(),
      grossProfit: pnl.grossProfit.toString(),
      totalGasHemi: pnl.totalGasHemi.toString(),
      totalGasEth: pnl.totalGasEth.toString(),
      netProfit: pnl.netProfit.toString(),
    });
  }
}

// Format bigint for display (VCRED has 18 decimals)
export function formatVcred(amount: bigint): string {
  const whole = amount / 10n ** 18n;
  const frac = (amount % 10n ** 18n).toString().padStart(18, '0').slice(0, 4);
  return `${whole}.${frac}`;
}

// Format ETH amount for display
export function formatEth(amount: bigint): string {
  const whole = amount / 10n ** 18n;
  const frac = (amount % 10n ** 18n).toString().padStart(18, '0').slice(0, 6);
  return `${whole}.${frac}`;
}
