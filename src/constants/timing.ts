/**
 * Timing constants used across the keeper
 */

// Transaction receipt timeout
export const TX_RECEIPT_TIMEOUT_MS = 120_000;

// Hemi challenge period for OP-stack withdrawals (1 day in seconds)
export const HEMI_CHALLENGE_PERIOD_SECONDS = 86400n;

// Sleep duration when VCRED balance is too low (60 minutes)
export const VCRED_SLEEP_DURATION_MS = 60 * 60 * 1000;

// Maximum actions per reconciler loop iteration
export const MAX_ACTIONS_PER_LOOP = 3;

// Maximum quote API calls during sizing binary search
export const MAX_QUOTE_CALLS = 15;

// Maximum age for swap quotes before re-quoting (30 seconds)
export const MAX_QUOTE_AGE_MS = 30_000;

// Default VCRED amount for opportunity detection (1000 VCRED units, without decimals)
export const DEFAULT_TEST_VCRED_AMOUNT = 1000n;

// Health check degraded threshold for RPC calls
export const HEALTH_CHECK_RPC_DEGRADED_THRESHOLD_MS = 2000;

// Health check degraded threshold for contract calls
export const HEALTH_CHECK_CONTRACT_DEGRADED_THRESHOLD_MS = 3000;

// Retry defaults
export const RETRY_MAX_ATTEMPTS = 3;
export const RETRY_BASE_DELAY_MS = 1000;
export const RETRY_MAX_DELAY_MS = 30_000;

// Max retries for CLOSE_SWAP on-chain failures (tx reverts)
// These are reconciler-level retries, not within-call retries
export const MAX_CLOSE_SWAP_RETRIES = 3;

// Max retries for ETH_SWAP on-chain failures (tx reverts)
// These are reconciler-level retries, not within-call retries
export const MAX_ETH_SWAP_RETRIES = 3;

// CowSwap order polling
export const COWSWAP_POLL_INTERVAL_MS = 15_000;
export const COWSWAP_ORDER_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
