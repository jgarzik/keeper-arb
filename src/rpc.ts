/**
 * RPC URL exports for backward compatibility.
 * Single source of truth is in config.ts.
 */
import { HEMI_RPC_URL, ETH_RPC_URL } from './config.js';

export const RPC_URLS = {
  hemi: HEMI_RPC_URL,
  ethereum: ETH_RPC_URL,
} as const;
