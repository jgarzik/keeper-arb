import { type Clients, getPublicClient } from '../wallet.js';
import { type ProviderHealth } from './swapInterface.js';
import { CHAIN_ID_ETHEREUM, CHAIN_ID_HEMI } from '../chains.js';
import { sushiApiProvider } from './dex/sushiApi.js';
import { zeroXApiProvider } from './dex/zeroXApi.js';
import { oneDeltaApiProvider } from './dex/oneDeltaApi.js';
import {
  STARGATE_POOL_NATIVE,
  UNISWAP_QUOTER_V2,
  HEMI_OPTIMISM_PORTAL,
  LZ_ENDPOINT_IDS,
} from '../constants/contracts.js';
import {
  HEALTH_CHECK_RPC_DEGRADED_THRESHOLD_MS,
  HEALTH_CHECK_CONTRACT_DEGRADED_THRESHOLD_MS,
} from '../constants/timing.js';

const STARGATE_QUOTE_SEND_ABI = [
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

const QUOTER_ABI = [
  {
    name: 'quoteExactInputSingle',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'params',
        type: 'tuple',
        components: [
          { name: 'tokenIn', type: 'address' },
          { name: 'tokenOut', type: 'address' },
          { name: 'amountIn', type: 'uint256' },
          { name: 'fee', type: 'uint24' },
          { name: 'sqrtPriceLimitX96', type: 'uint160' },
        ],
      },
    ],
    outputs: [
      { name: 'amountOut', type: 'uint256' },
      { name: 'sqrtPriceX96After', type: 'uint160' },
      { name: 'initializedTicksCrossed', type: 'uint32' },
      { name: 'gasEstimate', type: 'uint256' },
    ],
  },
] as const;

const OPTIMISM_PORTAL_ABI = [
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

function addressToBytes32(addr: string): `0x${string}` {
  return `0x${addr.slice(2).padStart(64, '0')}` as `0x${string}`;
}

async function checkStargateHealth(clients: Clients): Promise<ProviderHealth> {
  const start = Date.now();
  try {
    const publicClient = getPublicClient(clients, CHAIN_ID_ETHEREUM);

    // Call quoteSend with small amount to check contract is responsive
    // Stargate has minimum amounts, use 0.001 ETH
    await publicClient.readContract({
      address: STARGATE_POOL_NATIVE[CHAIN_ID_ETHEREUM],
      abi: STARGATE_QUOTE_SEND_ABI,
      functionName: 'quoteSend',
      args: [
        {
          dstEid: LZ_ENDPOINT_IDS[CHAIN_ID_HEMI],
          to: addressToBytes32(clients.address),
          amountLD: 1000000000000000n, // 0.001 ETH
          minAmountLD: 0n,
          extraOptions: '0x',
          composeMsg: '0x',
          oftCmd: '0x',
        },
        false,
      ],
    });

    const latencyMs = Date.now() - start;
    return {
      provider: 'Stargate',
      status: latencyMs > HEALTH_CHECK_CONTRACT_DEGRADED_THRESHOLD_MS ? 'degraded' : 'ok',
      latencyMs,
      details: {
        ethContract: STARGATE_POOL_NATIVE[CHAIN_ID_ETHEREUM],
        hemiContract: STARGATE_POOL_NATIVE[CHAIN_ID_HEMI],
      },
    };
  } catch (err) {
    return {
      provider: 'Stargate',
      status: 'error',
      latencyMs: Date.now() - start,
      error: String(err),
    };
  }
}

async function checkHemiTunnelHealth(clients: Clients): Promise<ProviderHealth> {
  const start = Date.now();
  try {
    const publicClient = getPublicClient(clients, CHAIN_ID_ETHEREUM);

    // Read provenWithdrawals with a dummy hash to check contract is responsive
    const dummyHash = '0x0000000000000000000000000000000000000000000000000000000000000000' as `0x${string}`;
    await publicClient.readContract({
      address: HEMI_OPTIMISM_PORTAL,
      abi: OPTIMISM_PORTAL_ABI,
      functionName: 'provenWithdrawals',
      args: [dummyHash],
    });

    const latencyMs = Date.now() - start;
    return {
      provider: 'HemiTunnel',
      status: latencyMs > HEALTH_CHECK_CONTRACT_DEGRADED_THRESHOLD_MS ? 'degraded' : 'ok',
      latencyMs,
      details: { portal: HEMI_OPTIMISM_PORTAL },
    };
  } catch (err) {
    return {
      provider: 'HemiTunnel',
      status: 'error',
      latencyMs: Date.now() - start,
      error: String(err),
    };
  }
}

async function checkUniswapRefHealth(clients: Clients): Promise<ProviderHealth> {
  const start = Date.now();
  try {
    const publicClient = getPublicClient(clients, CHAIN_ID_ETHEREUM);

    // WETH -> USDC quote with 1 wei
    await publicClient.readContract({
      address: UNISWAP_QUOTER_V2,
      abi: QUOTER_ABI,
      functionName: 'quoteExactInputSingle',
      args: [
        {
          tokenIn: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' as `0x${string}`, // WETH
          tokenOut: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' as `0x${string}`, // USDC
          amountIn: 1000000000000000n, // 0.001 ETH
          fee: 500,
          sqrtPriceLimitX96: 0n,
        },
      ],
    });

    const latencyMs = Date.now() - start;
    return {
      provider: 'UniswapRef',
      status: latencyMs > HEALTH_CHECK_CONTRACT_DEGRADED_THRESHOLD_MS ? 'degraded' : 'ok',
      latencyMs,
      details: { quoter: UNISWAP_QUOTER_V2 },
    };
  } catch (err) {
    return {
      provider: 'UniswapRef',
      status: 'error',
      latencyMs: Date.now() - start,
      error: String(err),
    };
  }
}

async function checkHemiRpc(clients: Clients): Promise<ProviderHealth> {
  const start = Date.now();
  try {
    const publicClient = getPublicClient(clients, CHAIN_ID_HEMI);
    await publicClient.getBlockNumber();

    const latencyMs = Date.now() - start;
    return {
      provider: 'Hemi RPC',
      status: latencyMs > HEALTH_CHECK_RPC_DEGRADED_THRESHOLD_MS ? 'degraded' : 'ok',
      latencyMs,
    };
  } catch (err) {
    return {
      provider: 'Hemi RPC',
      status: 'error',
      latencyMs: Date.now() - start,
      error: String(err),
    };
  }
}

async function checkEthereumRpc(clients: Clients): Promise<ProviderHealth> {
  const start = Date.now();
  try {
    const publicClient = getPublicClient(clients, CHAIN_ID_ETHEREUM);
    await publicClient.getBlockNumber();

    const latencyMs = Date.now() - start;
    return {
      provider: 'Ethereum RPC',
      status: latencyMs > HEALTH_CHECK_RPC_DEGRADED_THRESHOLD_MS ? 'degraded' : 'ok',
      latencyMs,
    };
  } catch (err) {
    return {
      provider: 'Ethereum RPC',
      status: 'error',
      latencyMs: Date.now() - start,
      error: String(err),
    };
  }
}

export interface HealthCheckResult {
  timestamp: string;
  providers: ProviderHealth[];
  summary: {
    total: number;
    ok: number;
    degraded: number;
    error: number;
  };
}

export async function checkAllProviders(clients: Clients): Promise<HealthCheckResult> {
  const checks: Promise<ProviderHealth>[] = [
    // DEX API providers
    sushiApiProvider.checkHealth!(),
    zeroXApiProvider.checkHealth!(),
    oneDeltaApiProvider.checkHealth!(),
    // Bridge providers
    checkStargateHealth(clients),
    checkHemiTunnelHealth(clients),
    // Reference price provider
    checkUniswapRefHealth(clients),
    // RPC health
    checkHemiRpc(clients),
    checkEthereumRpc(clients),
  ];

  const results = await Promise.all(checks);

  return {
    timestamp: new Date().toISOString(),
    providers: results,
    summary: {
      total: results.length,
      ok: results.filter((r) => r.status === 'ok').length,
      degraded: results.filter((r) => r.status === 'degraded').length,
      error: results.filter((r) => r.status === 'error').length,
    },
  };
}
