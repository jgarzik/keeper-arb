import {
  createPublicClient,
  createWalletClient,
  http,
  type PublicClient,
  type WalletClient,
  type Address,
  type Chain,
  type Transport,
  type Account,
  formatUnits,
} from 'viem';
import { privateKeyToAccount, mnemonicToAccount } from 'viem/accounts';
import { hemiMainnet, ethereumMainnet, CHAIN_ID_HEMI, CHAIN_ID_ETHEREUM } from './chains.js';
import { type Config } from './config.js';
import { diag } from './logging.js';
import { TOKENS, type TokenId, getTokenAddress } from './tokens.js';
import { withRetry } from './retry.js';

// ERC20 minimal ABI for balance checks
const ERC20_ABI = [
  {
    name: 'balanceOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'allowance',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'approve',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const;

export interface Clients {
  account: Account;
  address: Address;
  hemiPublic: PublicClient<Transport, Chain>;
  ethPublic: PublicClient<Transport, Chain>;
  hemiWallet: WalletClient<Transport, Chain, Account>;
  ethWallet: WalletClient<Transport, Chain, Account>;
}

// Nonce tracking per chain with mutex to prevent race conditions
const nonceCache: Map<number, bigint> = new Map();
const nonceLocks: Map<number, Promise<void>> = new Map();

export function initClients(config: Config): Clients {
  // Create account from private key or mnemonic
  let account: Account;
  if (config.walletPrivateKey) {
    account = privateKeyToAccount(config.walletPrivateKey as `0x${string}`);
  } else if (config.walletMnemonic) {
    account = mnemonicToAccount(config.walletMnemonic);
  } else {
    throw new Error('No wallet credentials provided');
  }

  diag.info('Wallet initialized', { address: account.address });

  // Public clients (read-only)
  const hemiPublic = createPublicClient({
    chain: hemiMainnet,
    transport: http(config.hemiRpcUrl),
  });

  const ethPublic = createPublicClient({
    chain: ethereumMainnet,
    transport: http(config.ethRpcUrl),
  });

  // Wallet clients (signing)
  const hemiWallet = createWalletClient({
    account,
    chain: hemiMainnet,
    transport: http(config.hemiRpcUrl),
  });

  const ethWallet = createWalletClient({
    account,
    chain: ethereumMainnet,
    transport: http(config.ethRpcUrl),
  });

  return {
    account,
    address: account.address,
    hemiPublic,
    ethPublic,
    hemiWallet,
    ethWallet,
  };
}

export function getPublicClient(clients: Clients, chainId: number): PublicClient<Transport, Chain> {
  switch (chainId) {
    case CHAIN_ID_HEMI:
      return clients.hemiPublic;
    case CHAIN_ID_ETHEREUM:
      return clients.ethPublic;
    default:
      throw new Error(`No public client for chain ${chainId}`);
  }
}

export function getWalletClient(clients: Clients, chainId: number): WalletClient<Transport, Chain, Account> {
  switch (chainId) {
    case CHAIN_ID_HEMI:
      return clients.hemiWallet;
    case CHAIN_ID_ETHEREUM:
      return clients.ethWallet;
    default:
      throw new Error(`No wallet client for chain ${chainId}`);
  }
}

// Nonce management with mutex to prevent race conditions
export async function getNextNonce(clients: Clients, chainId: number): Promise<bigint> {
  // Wait for any pending lock on this chain
  const existingLock = nonceLocks.get(chainId);
  if (existingLock) {
    await existingLock;
  }

  // Create new lock
  let releaseLock: () => void;
  const lock = new Promise<void>((resolve) => {
    releaseLock = resolve;
  });
  nonceLocks.set(chainId, lock);

  try {
    const publicClient = getPublicClient(clients, chainId);

    // Get onchain nonce with retry for transient errors
    const onchainNonce = await withRetry(() =>
      publicClient.getTransactionCount({
        address: clients.address,
      })
    );

    // Use max of cached and onchain
    const cached = nonceCache.get(chainId) ?? 0n;
    const next = cached >= BigInt(onchainNonce) ? cached : BigInt(onchainNonce);

    // Increment cache
    nonceCache.set(chainId, next + 1n);

    return next;
  } finally {
    releaseLock!();
    nonceLocks.delete(chainId);
  }
}

export function resetNonceCache(chainId?: number): void {
  if (chainId !== undefined) {
    nonceCache.delete(chainId);
  } else {
    nonceCache.clear();
  }
}

// Balance utilities
export async function getNativeBalance(clients: Clients, chainId: number): Promise<bigint> {
  const publicClient = getPublicClient(clients, chainId);
  return publicClient.getBalance({ address: clients.address });
}

export async function getTokenBalance(
  clients: Clients,
  chainId: number,
  tokenAddress: Address
): Promise<bigint> {
  const publicClient = getPublicClient(clients, chainId);
  return publicClient.readContract({
    address: tokenAddress,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: [clients.address],
  });
}

export async function getTokenAllowance(
  clients: Clients,
  chainId: number,
  tokenAddress: Address,
  spender: Address
): Promise<bigint> {
  const publicClient = getPublicClient(clients, chainId);
  return publicClient.readContract({
    address: tokenAddress,
    abi: ERC20_ABI,
    functionName: 'allowance',
    args: [clients.address, spender],
  });
}

export async function approveToken(
  clients: Clients,
  chainId: number,
  tokenAddress: Address,
  spender: Address,
  amount: bigint
): Promise<`0x${string}`> {
  const walletClient = getWalletClient(clients, chainId);
  const nonce = await getNextNonce(clients, chainId);

  const hash = await walletClient.writeContract({
    address: tokenAddress,
    abi: ERC20_ABI,
    functionName: 'approve',
    args: [spender, amount],
    nonce: Number(nonce),
  });

  diag.info('Token approval submitted', {
    chainId,
    token: tokenAddress,
    spender,
    amount: amount.toString(),
    txHash: hash,
  });

  return hash;
}

// Get all balances for dashboard/monitoring
export interface BalanceSnapshot {
  chainId: number;
  native: bigint;
  tokens: Record<TokenId, bigint>;
}

export async function getAllBalances(clients: Clients): Promise<BalanceSnapshot[]> {
  const results: BalanceSnapshot[] = [];

  for (const chainId of [CHAIN_ID_HEMI, CHAIN_ID_ETHEREUM]) {
    const native = await getNativeBalance(clients, chainId);
    const tokens: Record<string, bigint> = {};

    for (const [tokenId] of Object.entries(TOKENS)) {
      const addr = getTokenAddress(tokenId as TokenId, chainId);
      if (addr) {
        try {
          tokens[tokenId] = await getTokenBalance(clients, chainId, addr);
        } catch {
          tokens[tokenId] = 0n;
        }
      }
    }

    results.push({ chainId, native, tokens: tokens as Record<TokenId, bigint> });
  }

  return results;
}

export function formatBalance(amount: bigint, decimals: number): string {
  return formatUnits(amount, decimals);
}
