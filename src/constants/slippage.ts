/**
 * Slippage constants and helper functions
 *
 * Different slippage values are intentional:
 * - 5% (95/100): Balance checks after swaps - accounts for price slippage during execution
 * - 2% (98/100): Bridge arrival detection - accounts for bridge fees
 * - 1% (99/100): Bridge minAmountLD - on-chain enforcement, tighter tolerance
 */

// Balance check tolerance (5%) - accounts for price slippage after swaps
export const SLIPPAGE_BALANCE_CHECK_MULTIPLIER = 95n;
export const SLIPPAGE_BALANCE_CHECK_DIVISOR = 100n;

// Bridge arrival detection (2%) - accounts for bridge fees
export const SLIPPAGE_BRIDGE_ARRIVAL_MULTIPLIER = 98n;
export const SLIPPAGE_BRIDGE_ARRIVAL_DIVISOR = 100n;

// Bridge minAmountLD (1%) - on-chain enforcement, tighter tolerance
export const SLIPPAGE_BRIDGE_MIN_AMOUNT_MULTIPLIER = 99n;
export const SLIPPAGE_BRIDGE_MIN_AMOUNT_DIVISOR = 100n;

/**
 * Apply balance check tolerance (5% slippage)
 * Used after swaps to verify expected output was received
 */
export function applyBalanceCheckTolerance(amount: bigint): bigint {
  return (amount * SLIPPAGE_BALANCE_CHECK_MULTIPLIER) / SLIPPAGE_BALANCE_CHECK_DIVISOR;
}

/**
 * Apply bridge arrival tolerance (2% slippage)
 * Used to detect when bridged funds have arrived
 */
export function applyBridgeArrivalTolerance(amount: bigint): bigint {
  return (amount * SLIPPAGE_BRIDGE_ARRIVAL_MULTIPLIER) / SLIPPAGE_BRIDGE_ARRIVAL_DIVISOR;
}

/**
 * Apply bridge minAmountLD (1% slippage)
 * Used for on-chain bridge enforcement
 */
export function applyBridgeMinAmount(amount: bigint): bigint {
  return (amount * SLIPPAGE_BRIDGE_MIN_AMOUNT_MULTIPLIER) / SLIPPAGE_BRIDGE_MIN_AMOUNT_DIVISOR;
}
