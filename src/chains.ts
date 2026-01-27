import { type Chain } from 'viem';
import { RPC_URLS } from './rpc.js';

export const CHAIN_ID_HEMI = 43111;
export const CHAIN_ID_ETHEREUM = 1;

export const hemiMainnet: Chain = {
  id: CHAIN_ID_HEMI,
  name: 'Hemi',
  nativeCurrency: {
    name: 'Ether',
    symbol: 'ETH',
    decimals: 18,
  },
  rpcUrls: {
    default: {
      http: [RPC_URLS.hemi],
    },
  },
  blockExplorers: {
    default: {
      name: 'Hemi Explorer',
      url: 'https://explorer.hemi.xyz',
    },
  },
};

export const ethereumMainnet: Chain = {
  id: CHAIN_ID_ETHEREUM,
  name: 'Ethereum',
  nativeCurrency: {
    name: 'Ether',
    symbol: 'ETH',
    decimals: 18,
  },
  rpcUrls: {
    default: {
      http: [RPC_URLS.ethereum],
    },
  },
  blockExplorers: {
    default: {
      name: 'Etherscan',
      url: 'https://etherscan.io',
    },
  },
  contracts: {
    multicall3: {
      address: '0xcA11bde05977b3631167028862bE2a173976CA11',
    },
  },
};

export function getChainById(chainId: number): Chain {
  switch (chainId) {
    case CHAIN_ID_HEMI:
      return hemiMainnet;
    case CHAIN_ID_ETHEREUM:
      return ethereumMainnet;
    default:
      throw new Error(`Unknown chain ID: ${chainId}`);
  }
}

export function getExplorerTxUrl(chainId: number, txHash: string): string {
  const chain = getChainById(chainId);
  return `${chain.blockExplorers?.default.url}/tx/${txHash}`;
}
