import { type Address } from 'viem';
import { CHAIN_ID_HEMI, CHAIN_ID_ETHEREUM } from './chains.js';

export type TokenId =
  | 'VCRED'
  | 'USDC'
  | 'WETH'
  | 'WBTC'
  | 'hemiBTC'
  | 'cbBTC'
  | 'XAUt'
  | 'VUSD';

export type BridgeRoute = 'STARGATE_LZ' | 'HEMI_TUNNEL';

export interface TokenMeta {
  id: TokenId;
  symbol: string;
  decimals: number;
  addresses: Partial<Record<number, Address>>;
  bridgeRouteOut?: BridgeRoute; // Hemi → Ethereum
  minSwapVcred?: bigint;
  maxSwapVcredSoftCap?: bigint;
}

export const TOKENS: Record<TokenId, TokenMeta> = {
  VCRED: {
    id: 'VCRED',
    symbol: 'VCRED',
    decimals: 6,
    addresses: {
      [CHAIN_ID_HEMI]: '0x71881974e96152643C74A8e0214B877CfB2A0Aa1',
    },
  },
  USDC: {
    id: 'USDC',
    symbol: 'USDC',
    decimals: 6,
    addresses: {
      [CHAIN_ID_ETHEREUM]: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
      [CHAIN_ID_HEMI]: '0xad11a8BEb98bbf61dbb1aa0F6d6F2ECD87b35afA', // Stargate bridged USDC.e
    },
    bridgeRouteOut: 'STARGATE_LZ',
  },
  WETH: {
    id: 'WETH',
    symbol: 'WETH',
    decimals: 18,
    addresses: {
      [CHAIN_ID_ETHEREUM]: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
      [CHAIN_ID_HEMI]: '0x4200000000000000000000000000000000000006',
    },
    bridgeRouteOut: 'STARGATE_LZ',
  },
  WBTC: {
    id: 'WBTC',
    symbol: 'WBTC',
    decimals: 8,
    addresses: {
      [CHAIN_ID_ETHEREUM]: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599',
    },
    bridgeRouteOut: 'HEMI_TUNNEL',
  },
  hemiBTC: {
    id: 'hemiBTC',
    symbol: 'hemiBTC',
    decimals: 8,
    addresses: {
      [CHAIN_ID_HEMI]: '0xAA40c0c7644e0b2B224509571e10ad20d9C4ef28',
    },
    bridgeRouteOut: 'STARGATE_LZ',
  },
  cbBTC: {
    id: 'cbBTC',
    symbol: 'cbBTC',
    decimals: 8,
    addresses: {
      [CHAIN_ID_ETHEREUM]: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf',
    },
    bridgeRouteOut: 'HEMI_TUNNEL',
  },
  XAUt: {
    id: 'XAUt',
    symbol: 'XAUt',
    decimals: 6,
    addresses: {
      [CHAIN_ID_ETHEREUM]: '0x68749665FF8D2d112Fa859AA293F07A622782F38',
    },
    bridgeRouteOut: 'HEMI_TUNNEL',
  },
  VUSD: {
    id: 'VUSD',
    symbol: 'VUSD',
    decimals: 18,
    addresses: {
      [CHAIN_ID_ETHEREUM]: '0x677ddbd918637E5F2c79e164D402454dE7dA8619',
      [CHAIN_ID_HEMI]: '0x7A06C4AeF988e7925575C50261297a946aD204A8',
    },
    bridgeRouteOut: 'HEMI_TUNNEL',
  },
};

// Tokens eligible for the arb loop (VCRED → X on Hemi)
export const ARB_TARGET_TOKENS: TokenId[] = ['WETH', 'WBTC', 'hemiBTC', 'cbBTC', 'XAUt', 'VUSD'];

export function getToken(id: TokenId): TokenMeta {
  return TOKENS[id];
}

export function getTokenAddress(id: TokenId, chainId: number): Address | undefined {
  return TOKENS[id].addresses[chainId];
}

export function requireTokenAddress(id: TokenId, chainId: number): Address {
  const addr = getTokenAddress(id, chainId);
  if (!addr) {
    throw new Error(`Token ${id} not available on chain ${chainId}`);
  }
  return addr;
}

/**
 * Validate a string as a TokenId (used for DB results and user input)
 */
export function validateTokenId(value: string): TokenId {
  if (!(value in TOKENS)) {
    throw new Error(`Invalid TokenId: ${value}`);
  }
  return value as TokenId;
}
