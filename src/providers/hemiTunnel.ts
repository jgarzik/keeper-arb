import { type Address, defineChain, encodeFunctionData, parseEventLogs } from 'viem';
import { chainConfig } from 'viem/op-stack';
import {
  publicActionsL1,
  publicActionsL2,
  walletActionsL1,
  getWithdrawals,
} from 'viem/op-stack';
import { type Clients, getPublicClient, getWalletClient, getNextNonce, getTokenBalance, getTokenAllowance, approveToken, safeNonceToNumber } from '../wallet.js';
import {
  type BridgeProvider,
  type BridgeTransaction,
  type BridgeStatus,
} from './bridgeInterface.js';
import { CHAIN_ID_HEMI, CHAIN_ID_ETHEREUM } from '../chains.js';
import { diag } from '../logging.js';
import {
  HEMI_OPTIMISM_PORTAL,
  HEMI_L2_OUTPUT_ORACLE,
  HEMI_L2_STANDARD_BRIDGE,
  L2_TO_L1_MESSAGE_PASSER,
} from '../constants/contracts.js';
import { DEFAULT_HEMI_RPC_URL } from '../constants/api.js';
import { TX_RECEIPT_TIMEOUT_MS, HEMI_CHALLENGE_PERIOD_SECONDS } from '../constants/timing.js';
import { applyBridgeArrivalTolerance } from '../constants/slippage.js';

// Define Hemi as an OP-stack chain for viem's OP utilities
const hemiOpStack = defineChain({
  ...chainConfig,
  id: CHAIN_ID_HEMI,
  name: 'Hemi',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [DEFAULT_HEMI_RPC_URL] } },
  contracts: {
    ...chainConfig.contracts,
    portal: { [CHAIN_ID_ETHEREUM]: { address: HEMI_OPTIMISM_PORTAL } },
    l2OutputOracle: { [CHAIN_ID_ETHEREUM]: { address: HEMI_L2_OUTPUT_ORACLE } },
  },
  sourceId: CHAIN_ID_ETHEREUM, // Ethereum mainnet
});

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
const MESSAGE_PASSED_EVENT = {
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
      _recipient: Address
    ): Promise<BridgeTransaction> {
      if (!isWithdrawal) {
        throw new Error('Hemi tunnel deposits should use L1 Standard Bridge directly');
      }

      const publicClient = getPublicClient(clients, CHAIN_ID_HEMI);
      const walletClient = getWalletClient(clients, CHAIN_ID_HEMI);

      // Ensure token approval for bridge (exact amount only, not infinite)
      const allowance = await getTokenAllowance(clients, CHAIN_ID_HEMI, token, HEMI_L2_STANDARD_BRIDGE);
      if (allowance < amount) {
        diag.info('Approving token for Hemi tunnel bridge', {
          token,
          spender: HEMI_L2_STANDARD_BRIDGE,
          amount: amount.toString(),
        });
        const approvalHash = await approveToken(clients, CHAIN_ID_HEMI, token, HEMI_L2_STANDARD_BRIDGE, amount);
        await publicClient.waitForTransactionReceipt({ hash: approvalHash, timeout: TX_RECEIPT_TIMEOUT_MS });
      }

      const nonce = await getNextNonce(clients, CHAIN_ID_HEMI);

      // Withdraw from L2 to L1 (sends to msg.sender on L1)
      // Using 'withdraw' not 'withdrawTo' per Hemi's implementation
      const data = encodeFunctionData({
        abi: L2_STANDARD_BRIDGE_ABI,
        functionName: 'withdraw',
        args: [
          token,
          amount,
          0, // minGasLimit (Hemi uses 0)
          '0x',
        ],
      });

      // Estimate EIP-1559 fees
      const fees = await publicClient.estimateFeesPerGas();

      // Estimate gas with account for simulation
      const gasEstimate = await publicClient.estimateGas({
        account: clients.account,
        to: HEMI_L2_STANDARD_BRIDGE,
        data,
        value: 0n,
        maxFeePerGas: fees.maxFeePerGas,
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      });

      // Pad gas by 20% for contract calls
      const gas = (gasEstimate * 12n) / 10n;

      // Send transaction (walletClient has account configured for local signing)
      const hash = await walletClient.sendTransaction({
        to: HEMI_L2_STANDARD_BRIDGE,
        data,
        value: 0n,
        gas,
        maxFeePerGas: fees.maxFeePerGas,
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
        nonce: safeNonceToNumber(nonce),
      });

      // Wait for receipt and extract withdrawalHash
      const receipt = await publicClient.waitForTransactionReceipt({
        hash,
        timeout: TX_RECEIPT_TIMEOUT_MS,
      });

      let withdrawalHash: `0x${string}` | undefined;
      let withdrawalData: string | undefined;
      if (receipt.status === 'success') {
        const logs = parseEventLogs({
          abi: [MESSAGE_PASSED_EVENT],
          logs: receipt.logs,
        });
        if (logs.length > 0) {
          withdrawalHash = logs[0].args.withdrawalHash as `0x${string}`;
          // Store all withdrawal event data for prove/finalize steps
          withdrawalData = JSON.stringify({
            nonce: logs[0].args.nonce!.toString(),
            sender: logs[0].args.sender,
            target: logs[0].args.target,
            value: logs[0].args.value!.toString(),
            gasLimit: logs[0].args.gasLimit!.toString(),
            data: logs[0].args.data,
          });
        }
      }

      diag.info('Hemi tunnel withdrawal initiated', {
        token,
        amount: amount.toString(),
        txHash: hash,
        withdrawalHash,
      });

      return {
        provider: this.name,
        fromChainId,
        toChainId,
        token,
        amount,
        txHash: hash,
        status: receipt.status === 'success' ? 'sent' : 'failed',
        gasUsed: receipt.gasUsed,
        gasPrice: receipt.effectiveGasPrice,
        withdrawalHash,
        withdrawalData,
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
        if (receipt.status !== 'success') {
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
              // Check if enough time has passed for finalization (1 day for Hemi)
              const timestamp = proven[1];
              const now = BigInt(Math.floor(Date.now() / 1000));
              const finalizationPeriod = HEMI_CHALLENGE_PERIOD_SECONDS;

              if (now >= timestamp + finalizationPeriod) {
                // Check if finalized by checking destination balance
                const arrived = await this.detectArrival(clients, tx.token, applyBridgeArrivalTolerance(tx.amount));
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
      // Extend clients with OP-stack actions
      const l1Client = getPublicClient(clients, CHAIN_ID_ETHEREUM).extend(publicActionsL1());
      const l2Client = getPublicClient(clients, CHAIN_ID_HEMI).extend(publicActionsL2());
      const l1Wallet = getWalletClient(clients, CHAIN_ID_ETHEREUM).extend(walletActionsL1());

      // Get the original L2 transaction receipt
      const receipt = await l2Client.getTransactionReceipt({ hash: tx.txHash });

      // Check if L2 output is ready (non-blocking) before blocking on waitToProve
      try {
        const timeToProve = await l1Client.getTimeToProve({
          receipt,
          targetChain: hemiOpStack,
        });
        if (timeToProve.seconds > 0n) {
          diag.debug('L2 output not ready yet', {
            txHash: tx.txHash,
            secondsRemaining: timeToProve.seconds.toString(),
          });
          throw new Error(`L2_OUTPUT_NOT_READY:${timeToProve.seconds}`);
        }
      } catch (err) {
        // Re-throw our specific error
        if (String(err).includes('L2_OUTPUT_NOT_READY')) throw err;
        // L2 output not published yet - throw with unknown time
        diag.debug('L2 output not published yet', {
          txHash: tx.txHash,
          error: String(err),
        });
        throw new Error('L2_OUTPUT_NOT_READY:unknown');
      }

      diag.info('L2 output ready, proceeding with prove', { txHash: tx.txHash });

      // L2 output is ready - waitToProve will return immediately
      const { output, withdrawal } = await l1Client.waitToProve({
        receipt,
        targetChain: hemiOpStack,
      });

      // Build the prove withdrawal args
      const args = await l2Client.buildProveWithdrawal({
        output,
        withdrawal,
      });

      // Submit prove transaction on L1 (use portalAddress directly, omit targetChain)
      const { targetChain: _targetChain, ...proveArgs } = args;
      const hash = await l1Wallet.proveWithdrawal({
        ...proveArgs,
        portalAddress: HEMI_OPTIMISM_PORTAL,
      });

      diag.info('Prove withdrawal submitted', {
        txHash: tx.txHash,
        proveTxHash: hash,
      });

      return hash;
    },

    async finalize(
      clients: Clients,
      tx: BridgeTransaction
    ): Promise<`0x${string}`> {
      // Extend clients with OP-stack actions
      const l2Client = getPublicClient(clients, CHAIN_ID_HEMI).extend(publicActionsL2());
      const l1Wallet = getWalletClient(clients, CHAIN_ID_ETHEREUM).extend(walletActionsL1());

      // Get the original L2 transaction receipt and extract withdrawal
      const receipt = await l2Client.getTransactionReceipt({ hash: tx.txHash });
      const [withdrawal] = getWithdrawals(receipt);

      if (!withdrawal) {
        throw new Error(`No withdrawal found in transaction ${tx.txHash}`);
      }

      // Submit finalize transaction on L1
      const hash = await l1Wallet.finalizeWithdrawal({
        withdrawal,
        portalAddress: HEMI_OPTIMISM_PORTAL,
      });

      diag.info('Finalize withdrawal submitted', {
        txHash: tx.txHash,
        finalizeTxHash: hash,
      });

      return hash;
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
