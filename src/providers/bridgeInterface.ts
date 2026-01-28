import { type Address } from 'viem';
import { type Clients } from '../wallet.js';
import { type ProviderHealth } from './swapInterface.js';

export type BridgeStatus =
  | 'pending'
  | 'sent'
  | 'prove_required'
  | 'proved'
  | 'finalize_required'
  | 'finalized'
  | 'completed'
  | 'failed';

export interface BridgeTransaction {
  provider: string;
  fromChainId: number;
  toChainId: number;
  token: Address;
  amount: bigint;
  txHash: `0x${string}`;
  status: BridgeStatus;
  // Gas data from receipt
  gasUsed?: bigint;
  gasPrice?: bigint;
  // For LayerZero/Stargate bridges
  lzGuid?: `0x${string}`; // LayerZero message GUID for tracking on layerzeroscan.com
  // For Hemi tunnel
  withdrawalHash?: `0x${string}`;
  withdrawalData?: string; // JSON: {nonce, sender, target, value, gasLimit, data}
  proveHash?: `0x${string}`;
  finalizeHash?: `0x${string}`;
}

export interface BridgeProvider {
  name: string;
  fromChainId: number;
  toChainId: number;

  // Estimate bridge fee
  estimateFee(clients: Clients, token: Address, amount: bigint): Promise<bigint>;

  // Initiate bridge transfer
  send(
    clients: Clients,
    token: Address,
    amount: bigint,
    recipient: Address
  ): Promise<BridgeTransaction>;

  // Check status of a bridge transaction
  getStatus(clients: Clients, tx: BridgeTransaction): Promise<BridgeStatus>;

  // For multi-step bridges (Hemi tunnel)
  prove?(clients: Clients, tx: BridgeTransaction): Promise<`0x${string}`>;
  finalize?(clients: Clients, tx: BridgeTransaction): Promise<`0x${string}`>;

  // Detect arrival of funds on destination chain
  detectArrival(
    clients: Clients,
    token: Address,
    minAmount: bigint,
    sinceBlock?: bigint
  ): Promise<boolean>;

  // Optional health check
  checkHealth?(clients: Clients): Promise<ProviderHealth>;
}
