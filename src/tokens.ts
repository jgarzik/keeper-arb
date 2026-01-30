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

export interface ChainTokenInfo {
  address: Address;
  decimals: number;
}

export interface TokenMeta {
  id: TokenId;
  symbol: string;
  chains: Partial<Record<number, ChainTokenInfo>>;
  bridgeRouteOut?: BridgeRoute; // Hemi → Ethereum
  minSwapVcred?: bigint;
  maxSwapVcredSoftCap?: bigint;
  isStablecoin?: boolean; // True for USD-pegged tokens (USDC, VUSD, etc.)
}

export const TOKENS: Record<TokenId, TokenMeta> = {
  VCRED: {
    id: 'VCRED',
    symbol: 'VCRED',
    chains: {
      [CHAIN_ID_HEMI]: {
        address: '0x71881974e96152643C74A8e0214B877CfB2A0Aa1',
        decimals: 6,
      },
    },
    isStablecoin: true,
  },
  USDC: {
    id: 'USDC',
    symbol: 'USDC',
    chains: {
      [CHAIN_ID_ETHEREUM]: {
        address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
        decimals: 6,
      },
      [CHAIN_ID_HEMI]: {
        address: '0xad11a8BEb98bbf61dbb1aa0F6d6F2ECD87b35afA', // Stargate bridged USDC.e
        decimals: 6,
      },
    },
    bridgeRouteOut: 'STARGATE_LZ',
    isStablecoin: true,
  },
  WETH: {
    id: 'WETH',
    symbol: 'WETH',
    chains: {
      [CHAIN_ID_ETHEREUM]: {
        address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
        decimals: 18,
      },
      [CHAIN_ID_HEMI]: {
        address: '0x4200000000000000000000000000000000000006',
        decimals: 18,
      },
    },
    bridgeRouteOut: 'STARGATE_LZ',
  },
  WBTC: {
    id: 'WBTC',
    symbol: 'WBTC',
    chains: {
      [CHAIN_ID_ETHEREUM]: {
        address: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599',
        decimals: 8,
      },
      [CHAIN_ID_HEMI]: {
        address: '0x03C7054BCB39f7b2e5B2c7AcB37583e32D70Cfa3',
        decimals: 8,
      },
    },
    bridgeRouteOut: 'HEMI_TUNNEL',
  },
  hemiBTC: {
    id: 'hemiBTC',
    symbol: 'hemiBTC',
    chains: {
      [CHAIN_ID_ETHEREUM]: {
        address: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599', // WBTC on Ethereum
        decimals: 8,
      },
      [CHAIN_ID_HEMI]: {
        address: '0xAA40c0c7644e0b2B224509571e10ad20d9C4ef28',
        decimals: 8,
      },
    },
    bridgeRouteOut: 'STARGATE_LZ',
  },
  cbBTC: {
    id: 'cbBTC',
    symbol: 'cbBTC',
    chains: {
      [CHAIN_ID_ETHEREUM]: {
        address: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf',
        decimals: 8,
      },
      [CHAIN_ID_HEMI]: {
        address: '0x1596bE338B999E2376675C908168A7548C8B0525',
        decimals: 8,
      },
    },
    bridgeRouteOut: 'HEMI_TUNNEL',
  },
  XAUt: {
    id: 'XAUt',
    symbol: 'XAUt',
    chains: {
      [CHAIN_ID_ETHEREUM]: {
        address: '0x68749665FF8D2d112Fa859AA293F07A622782F38',
        decimals: 6,
      },
      [CHAIN_ID_HEMI]: {
        address: '0x028DE74e2fE336511A8E5FAb0426D1cfD5110DBb',
        decimals: 6,
      },
    },
    bridgeRouteOut: 'HEMI_TUNNEL',
  },
  VUSD: {
    id: 'VUSD',
    symbol: 'VUSD',
    chains: {
      [CHAIN_ID_ETHEREUM]: {
        address: '0x677ddbd918637E5F2c79e164D402454dE7dA8619',
        decimals: 18,
      },
      [CHAIN_ID_HEMI]: {
        address: '0x7A06C4AeF988e7925575C50261297a946aD204A8',
        decimals: 18,
      },
    },
    bridgeRouteOut: 'HEMI_TUNNEL',
    isStablecoin: true,
  },
};

// Tokens eligible for the arb loop (VCRED → X on Hemi)
export const ARB_TARGET_TOKENS: TokenId[] = ['WETH', 'WBTC', 'hemiBTC', 'cbBTC', 'XAUt', 'VUSD'];

export function getToken(id: TokenId): TokenMeta {
  return TOKENS[id];
}

export function getTokenAddress(id: TokenId, chainId: number): Address | undefined {
  return TOKENS[id].chains[chainId]?.address;
}

export function getTokenDecimals(id: TokenId, chainId: number): number | undefined {
  return TOKENS[id].chains[chainId]?.decimals;
}

export function requireTokenAddress(id: TokenId, chainId: number): Address {
  const addr = getTokenAddress(id, chainId);
  if (!addr) {
    throw new Error(`Token ${id} not available on chain ${chainId}`);
  }
  return addr;
}

export function requireTokenDecimals(id: TokenId, chainId: number): number {
  const decimals = getTokenDecimals(id, chainId);
  if (decimals === undefined) {
    throw new Error(`Token ${id} not available on chain ${chainId}`);
  }
  return decimals;
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

/**
 * Check if a token is a stablecoin (USD-pegged)
 */
export function isStablecoin(id: TokenId): boolean {
  return TOKENS[id].isStablecoin === true;
}
