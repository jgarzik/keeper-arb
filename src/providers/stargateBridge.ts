import { type Address, encodeFunctionData } from 'viem';
import { type Clients, getPublicClient, getWalletClient, getNextNonce, getTokenBalance, getTokenAllowance, approveToken } from '../wallet.js';
import {
  type BridgeProvider,
  type BridgeTransaction,
  type BridgeStatus,
} from './bridgeInterface.js';
import { CHAIN_ID_HEMI, CHAIN_ID_ETHEREUM } from '../chains.js';
import { diag } from '../logging.js';
import { getTokenAddress } from '../tokens.js';

// Stargate V2 contracts - Native ETH pool
const STARGATE_POOL_NATIVE: Record<number, Address> = {
  [CHAIN_ID_ETHEREUM]: '0x77b2043768d28E9C9aB44E1aBfC95944bcE57931', // StargatePoolNative
  [CHAIN_ID_HEMI]: '0x2F6F07CDcf3588944Bf4C42aC74ff24bF56e7590', // StargatePoolNative on Hemi
};

// Stargate V2 contracts - USDC OFT (Omnichain Fungible Token)
const STARGATE_OFT_USDC: Record<number, Address> = {
  [CHAIN_ID_ETHEREUM]: '0xc026395860Db2d07ee33e05fE50ed7bD583189C7',
  [CHAIN_ID_HEMI]: '0x45f1A95A4D3f3836523F5c83673c797f4d4d263B',
};

// LayerZero Endpoint IDs
const LZ_ENDPOINT_IDS: Record<number, number> = {
  [CHAIN_ID_ETHEREUM]: 30101,
  [CHAIN_ID_HEMI]: 30329, // Hemi LayerZero endpoint ID
};

const STARGATE_ABI = [
  {
    name: 'send',
    type: 'function',
    stateMutability: 'payable',
    inputs: [
      {
        name: 'sendParam',
        type: 'tuple',
        components: [
          { name: 'dstEid', type: 'uint32' },
          { name: 'to', type: 'bytes32' },
          { name: 'amountLD', type: 'uint256' },
          { name: 'minAmountLD', type: 'uint256' },
          { name: 'extraOptions', type: 'bytes' },
          { name: 'composeMsg', type: 'bytes' },
          { name: 'oftCmd', type: 'bytes' },
        ],
      },
      {
        name: 'fee',
        type: 'tuple',
        components: [
          { name: 'nativeFee', type: 'uint256' },
          { name: 'lzTokenFee', type: 'uint256' },
        ],
      },
      { name: 'refundAddress', type: 'address' },
    ],
    outputs: [
      {
        name: 'msgReceipt',
        type: 'tuple',
        components: [
          { name: 'guid', type: 'bytes32' },
          { name: 'nonce', type: 'uint64' },
          { name: 'fee', type: 'tuple', components: [
            { name: 'nativeFee', type: 'uint256' },
            { name: 'lzTokenFee', type: 'uint256' },
          ]},
        ],
      },
      {
        name: 'oftReceipt',
        type: 'tuple',
        components: [
          { name: 'amountSentLD', type: 'uint256' },
          { name: 'amountReceivedLD', type: 'uint256' },
        ],
      },
    ],
  },
  {
    name: 'quoteSend',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      {
        name: 'sendParam',
        type: 'tuple',
        components: [
          { name: 'dstEid', type: 'uint32' },
          { name: 'to', type: 'bytes32' },
          { name: 'amountLD', type: 'uint256' },
          { name: 'minAmountLD', type: 'uint256' },
          { name: 'extraOptions', type: 'bytes' },
          { name: 'composeMsg', type: 'bytes' },
          { name: 'oftCmd', type: 'bytes' },
        ],
      },
      { name: 'payInLzToken', type: 'bool' },
    ],
    outputs: [
      {
        name: 'fee',
        type: 'tuple',
        components: [
          { name: 'nativeFee', type: 'uint256' },
          { name: 'lzTokenFee', type: 'uint256' },
        ],
      },
    ],
  },
] as const;

function addressToBytes32(addr: Address): `0x${string}` {
  return `0x${addr.slice(2).padStart(64, '0')}` as `0x${string}`;
}

/**
 * Determine if a token uses the OFT (Omnichain Fungible Token) router
 * Currently only USDC uses OFT; native ETH uses StargatePoolNative
 */
function isOftToken(chainId: number, token: Address): boolean {
  const usdcAddress = getTokenAddress('USDC', chainId);
  return usdcAddress !== undefined && token.toLowerCase() === usdcAddress.toLowerCase();
}

/**
 * Get the appropriate Stargate router for a given token
 */
function getRouterForToken(chainId: number, token: Address): Address {
  if (isOftToken(chainId, token)) {
    return STARGATE_OFT_USDC[chainId];
  }
  return STARGATE_POOL_NATIVE[chainId];
}

function createStargateBridge(
  fromChainId: number,
  toChainId: number
): BridgeProvider {
  const dstEid = LZ_ENDPOINT_IDS[toChainId];

  return {
    name: `Stargate-${fromChainId}-${toChainId}`,
    fromChainId,
    toChainId,

    async estimateFee(
      clients: Clients,
      token: Address,
      amount: bigint
    ): Promise<bigint> {
      const routerAddress = getRouterForToken(fromChainId, token);
      if (!routerAddress) {
        diag.warn('Stargate router not configured', { fromChainId, token });
        return 0n;
      }

      const publicClient = getPublicClient(clients, fromChainId);
      const minAmount = (amount * 99n) / 100n; // 1% slippage

      try {
        const result = await publicClient.readContract({
          address: routerAddress,
          abi: STARGATE_ABI,
          functionName: 'quoteSend',
          args: [
            {
              dstEid,
              to: addressToBytes32(clients.address),
              amountLD: amount,
              minAmountLD: minAmount,
              extraOptions: '0x',
              composeMsg: '0x',
              oftCmd: '0x',
            },
            false,
          ],
        }) as { nativeFee: bigint; lzTokenFee: bigint };

        return result.nativeFee;
      } catch (err) {
        diag.warn('Failed to quote Stargate fee', { error: String(err), token });
        return 0n;
      }
    },

    async send(
      clients: Clients,
      token: Address,
      amount: bigint,
      recipient: Address
    ): Promise<BridgeTransaction> {
      const routerAddress = getRouterForToken(fromChainId, token);
      if (!routerAddress) {
        throw new Error('Stargate router not configured for this chain/token');
      }

      const walletClient = getWalletClient(clients, fromChainId);
      const publicClient = getPublicClient(clients, fromChainId);
      const useOft = isOftToken(fromChainId, token);

      const minAmount = (amount * 99n) / 100n;

      // For OFT tokens (USDC), ensure approval before send
      if (useOft) {
        const currentAllowance = await getTokenAllowance(clients, fromChainId, token, routerAddress);
        if (currentAllowance < amount) {
          diag.info('Approving Stargate OFT router for token spend', {
            token,
            router: routerAddress,
            amount: amount.toString(),
          });
          await approveToken(clients, fromChainId, token, routerAddress, amount);
        }
      }

      const nonce = await getNextNonce(clients, fromChainId);

      // Get fee quote first
      const feeResult = await publicClient.readContract({
        address: routerAddress,
        abi: STARGATE_ABI,
        functionName: 'quoteSend',
        args: [
          {
            dstEid,
            to: addressToBytes32(recipient),
            amountLD: amount,
            minAmountLD: minAmount,
            extraOptions: '0x',
            composeMsg: '0x',
            oftCmd: '0x',
          },
          false,
        ],
      }) as { nativeFee: bigint; lzTokenFee: bigint };

      // Execute bridge
      const data = encodeFunctionData({
        abi: STARGATE_ABI,
        functionName: 'send',
        args: [
          {
            dstEid,
            to: addressToBytes32(recipient),
            amountLD: amount,
            minAmountLD: minAmount,
            extraOptions: '0x',
            composeMsg: '0x',
            oftCmd: '0x',
          },
          { nativeFee: feeResult.nativeFee, lzTokenFee: 0n },
          clients.address,
        ],
      });

      // OFT tokens: value = nativeFee only (token transferred via approval)
      // Native ETH: value = nativeFee + amount (ETH sent with transaction)
      const txValue = useOft ? feeResult.nativeFee : feeResult.nativeFee + amount;

      const hash = await walletClient.sendTransaction({
        to: routerAddress,
        data,
        value: txValue,
        nonce: Number(nonce),
      });

      diag.info('Stargate bridge tx submitted', {
        fromChainId,
        toChainId,
        token,
        isOft: useOft,
        amount: amount.toString(),
        fee: feeResult.nativeFee.toString(),
        txHash: hash,
      });

      return {
        provider: this.name,
        fromChainId,
        toChainId,
        token,
        amount,
        txHash: hash,
        status: 'sent',
      };
    },

    async getStatus(
      clients: Clients,
      tx: BridgeTransaction
    ): Promise<BridgeStatus> {
      // Check if source tx is confirmed
      const publicClient = getPublicClient(clients, fromChainId);
      try {
        const receipt = await publicClient.getTransactionReceipt({
          hash: tx.txHash,
        });
        if (receipt.status === 'reverted') {
          return 'failed';
        }
      } catch {
        return 'pending';
      }

      // For Stargate, delivery is typically automatic via LayerZero
      // Check if funds arrived on destination
      const arrived = await this.detectArrival(clients, tx.token, tx.amount * 98n / 100n);
      return arrived ? 'completed' : 'sent';
    },

    async detectArrival(
      clients: Clients,
      token: Address,
      minAmount: bigint
    ): Promise<boolean> {
      try {
        const balance = await getTokenBalance(clients, toChainId, token);
        return balance >= minAmount;
      } catch {
        return false;
      }
    },
  };
}

// Export bridge instances
export const stargateHemiToEth = createStargateBridge(CHAIN_ID_HEMI, CHAIN_ID_ETHEREUM);
export const stargateEthToHemi = createStargateBridge(CHAIN_ID_ETHEREUM, CHAIN_ID_HEMI);
