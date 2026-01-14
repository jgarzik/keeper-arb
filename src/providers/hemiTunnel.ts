import { type Address, encodeFunctionData } from 'viem';
import { type Clients, getPublicClient, getWalletClient, getNextNonce, getTokenBalance } from '../wallet.js';
import {
  type BridgeProvider,
  type BridgeTransaction,
  type BridgeStatus,
} from './bridgeInterface.js';
import { CHAIN_ID_HEMI, CHAIN_ID_ETHEREUM } from '../chains.js';
import { diag } from '../logging.js';

// Hemi OP-stack bridge contracts (from constants.rs)
const _HEMI_L1_STANDARD_BRIDGE: Address = '0x5eaa10F99e7e6D177eF9F74E519E319aa49f191e';
const HEMI_L2_STANDARD_BRIDGE: Address = '0x4200000000000000000000000000000000000010';
const HEMI_OPTIMISM_PORTAL: Address = '0x39a0005415256B9863aFE2d55Edcf75ECc3A4D7e';

// L2 Standard Bridge ABI (withdraw functions)
const L2_STANDARD_BRIDGE_ABI = [
  {
    name: 'withdraw',
    type: 'function',
    stateMutability: 'payable',
    inputs: [
      { name: '_l2Token', type: 'address' },
      { name: '_amount', type: 'uint256' },
      { name: '_minGasLimit', type: 'uint32' },
      { name: '_extraData', type: 'bytes' },
    ],
    outputs: [],
  },
  {
    name: 'withdrawTo',
    type: 'function',
    stateMutability: 'payable',
    inputs: [
      { name: '_l2Token', type: 'address' },
      { name: '_amount', type: 'uint256' },
      { name: '_to', type: 'address' },
      { name: '_minGasLimit', type: 'uint32' },
      { name: '_extraData', type: 'bytes' },
    ],
    outputs: [],
  },
] as const;

// L1 Standard Bridge ABI (finalize functions)
const _L1_STANDARD_BRIDGE_ABI = [
  {
    name: 'finalizeERC20Withdrawal',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: '_l1Token', type: 'address' },
      { name: '_l2Token', type: 'address' },
      { name: '_from', type: 'address' },
      { name: '_to', type: 'address' },
      { name: '_amount', type: 'uint256' },
      { name: '_extraData', type: 'bytes' },
    ],
    outputs: [],
  },
] as const;

// OptimismPortal ABI
const OPTIMISM_PORTAL_ABI = [
  {
    name: 'proveWithdrawalTransaction',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: '_tx',
        type: 'tuple',
        components: [
          { name: 'nonce', type: 'uint256' },
          { name: 'sender', type: 'address' },
          { name: 'target', type: 'address' },
          { name: 'value', type: 'uint256' },
          { name: 'gasLimit', type: 'uint256' },
          { name: 'data', type: 'bytes' },
        ],
      },
      { name: '_l2OutputIndex', type: 'uint256' },
      {
        name: '_outputRootProof',
        type: 'tuple',
        components: [
          { name: 'version', type: 'bytes32' },
          { name: 'stateRoot', type: 'bytes32' },
          { name: 'messagePasserStorageRoot', type: 'bytes32' },
          { name: 'latestBlockhash', type: 'bytes32' },
        ],
      },
      { name: '_withdrawalProof', type: 'bytes[]' },
    ],
    outputs: [],
  },
  {
    name: 'finalizeWithdrawalTransaction',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: '_tx',
        type: 'tuple',
        components: [
          { name: 'nonce', type: 'uint256' },
          { name: 'sender', type: 'address' },
          { name: 'target', type: 'address' },
          { name: 'value', type: 'uint256' },
          { name: 'gasLimit', type: 'uint256' },
          { name: 'data', type: 'bytes' },
        ],
      },
    ],
    outputs: [],
  },
  {
    name: 'provenWithdrawals',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: '_withdrawalHash', type: 'bytes32' }],
    outputs: [
      { name: 'outputRoot', type: 'bytes32' },
      { name: 'timestamp', type: 'uint128' },
      { name: 'l2OutputIndex', type: 'uint128' },
    ],
  },
] as const;

// MessagePassed event on L2 (emitted when withdrawal initiated)
const _MESSAGE_PASSED_EVENT = {
  type: 'event',
  name: 'MessagePassed',
  inputs: [
    { indexed: true, name: 'nonce', type: 'uint256' },
    { indexed: true, name: 'sender', type: 'address' },
    { indexed: true, name: 'target', type: 'address' },
    { indexed: false, name: 'value', type: 'uint256' },
    { indexed: false, name: 'gasLimit', type: 'uint256' },
    { indexed: false, name: 'data', type: 'bytes' },
    { indexed: false, name: 'withdrawalHash', type: 'bytes32' },
  ],
} as const;

const L2_TO_L1_MESSAGE_PASSER: Address = '0x4200000000000000000000000000000000000016';

function createHemiTunnelBridge(
  fromChainId: number,
  toChainId: number
): BridgeProvider {
  const isWithdrawal = fromChainId === CHAIN_ID_HEMI;

  return {
    name: `HemiTunnel-${fromChainId}-${toChainId}`,
    fromChainId,
    toChainId,

    async estimateFee(
      _clients: Clients,
      _token: Address,
      _amount: bigint
    ): Promise<bigint> {
      // Hemi tunnel uses gas on both chains, estimate based on typical costs
      // The prove and finalize steps cost gas on L1
      return 50000000000000000n; // ~0.05 ETH estimate for L1 gas
    },

    async send(
      clients: Clients,
      token: Address,
      amount: bigint,
      recipient: Address
    ): Promise<BridgeTransaction> {
      if (!isWithdrawal) {
        throw new Error('Hemi tunnel deposits should use L1 Standard Bridge directly');
      }

      const walletClient = getWalletClient(clients, CHAIN_ID_HEMI);
      const nonce = await getNextNonce(clients, CHAIN_ID_HEMI);

      // Withdraw from L2 to L1
      const data = encodeFunctionData({
        abi: L2_STANDARD_BRIDGE_ABI,
        functionName: 'withdrawTo',
        args: [
          token,
          amount,
          recipient,
          200000, // minGasLimit
          '0x',
        ],
      });

      const hash = await walletClient.sendTransaction({
        to: HEMI_L2_STANDARD_BRIDGE,
        data,
        value: 0n,
        nonce: Number(nonce),
      });

      diag.info('Hemi tunnel withdrawal initiated', {
        token,
        amount: amount.toString(),
        recipient,
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
      const l2Client = getPublicClient(clients, CHAIN_ID_HEMI);
      try {
        const receipt = await l2Client.getTransactionReceipt({
          hash: tx.txHash,
        });
        if (receipt.status === 'reverted') {
          return 'failed';
        }

        // Parse MessagePassed event to get withdrawal hash
        const messagePassedLog = receipt.logs.find(
          (log) => log.address.toLowerCase() === L2_TO_L1_MESSAGE_PASSER.toLowerCase()
        );

        if (!messagePassedLog) {
          return 'sent';
        }

        // Check if proved
        if (tx.withdrawalHash) {
          const l1Client = getPublicClient(clients, CHAIN_ID_ETHEREUM);
          try {
            const proven = await l1Client.readContract({
              address: HEMI_OPTIMISM_PORTAL,
              abi: OPTIMISM_PORTAL_ABI,
              functionName: 'provenWithdrawals',
              args: [tx.withdrawalHash],
            }) as readonly [string, bigint, bigint];

            if (proven[1] > 0n) {
              // Check if enough time has passed for finalization (typically 7 days)
              const timestamp = proven[1];
              const now = BigInt(Math.floor(Date.now() / 1000));
              const finalizationPeriod = 604800n; // 7 days in seconds

              if (now >= timestamp + finalizationPeriod) {
                // Check if finalized by checking destination balance
                const arrived = await this.detectArrival(clients, tx.token, tx.amount * 98n / 100n);
                return arrived ? 'completed' : 'finalize_required';
              }
              return 'proved';
            }
          } catch {
            // Not proved yet
          }
        }

        return 'prove_required';
      } catch {
        return 'pending';
      }
    },

    async prove(
      clients: Clients,
      tx: BridgeTransaction
    ): Promise<`0x${string}`> {
      // This requires:
      // 1. Getting the L2 output root proof from Hemi's dispute game / L2OutputOracle
      // 2. Getting the withdrawal proof via eth_getProof
      // This is complex and typically requires an SDK or manual construction

      diag.warn('Prove step requires manual intervention or SDK integration', {
        txHash: tx.txHash,
      });

      // Placeholder - in production, use viem's OP stack utilities or SDK
      throw new Error(
        'Prove step not yet automated. Use Hemi bridge UI or SDK to prove withdrawal.'
      );
    },

    async finalize(
      clients: Clients,
      tx: BridgeTransaction
    ): Promise<`0x${string}`> {
      // This requires the withdrawal transaction details
      // Typically obtained from the original withdrawal event

      diag.warn('Finalize step requires withdrawal tx details', {
        txHash: tx.txHash,
      });

      // Placeholder - in production, decode the original tx and call finalizeWithdrawalTransaction
      throw new Error(
        'Finalize step not yet automated. Use Hemi bridge UI or SDK to finalize withdrawal.'
      );
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
export const hemiTunnelHemiToEth = createHemiTunnelBridge(CHAIN_ID_HEMI, CHAIN_ID_ETHEREUM);
export const hemiTunnelEthToHemi = createHemiTunnelBridge(CHAIN_ID_ETHEREUM, CHAIN_ID_HEMI);
