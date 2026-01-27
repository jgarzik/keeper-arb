/**
 * Single source of truth for RPC URLs.
 * Environment variables override these defaults.
 */
export const RPC_URLS = {
  hemi: 'https://rpc.hemi.network/rpc',
  ethereum: 'https://eth.llamarpc.com',
} as const;
