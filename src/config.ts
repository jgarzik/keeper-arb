import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { RPC_URLS } from './rpc.js';

export const WALLET_ADDRESS = '0x84a2Da9AAD3cdbA6C5C1Bea15Ac2441DB5B254cc';

export interface Config {
  // RPC endpoints
  hemiRpcUrl: string;
  ethRpcUrl: string;

  // Wallet (loaded once, never logged)
  walletPrivateKey: string;

  // Dashboard
  dashboardPort: number;
  dashboardPassword: string;

  // Notifications
  webhookUrl?: string;

  // Trading limits
  minSwapVcred: bigint;
  maxSwapVcredCap: bigint;

  // Timing
  reconcileIntervalMs: number;
  quotesTtlMs: number;

  // Paths
  dataDir: string;
  logsDir: string;
}

function optionalEnv(name: string, defaultValue: string): string {
  return process.env[name] ?? defaultValue;
}

function readSecret(name: string): string {
  const path = `/run/secrets/${name}`;
  try {
    const value = readFileSync(path, 'utf8').trim();
    if (!value) {
      throw new Error(`Docker secret ${name} is empty`);
    }
    return value;
  } catch (err: unknown) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') {
      throw new Error(`Missing required Docker secret: ${name} (expected at ${path})`);
    }
    throw err;
  }
}

export function loadConfig(): Config {
  return {
    hemiRpcUrl: process.env.HEMI_RPC_URL || RPC_URLS.hemi,
    ethRpcUrl: process.env.ETH_RPC_URL || RPC_URLS.ethereum,

    walletPrivateKey: readSecret('ARBITRAGE_PRIVATE_KEY'),

    dashboardPort: parseInt(optionalEnv('DASHBOARD_PORT', '7120'), 10),
    dashboardPassword: readSecret('DASHBOARD_PASSWORD'),

    webhookUrl: process.env.WEBHOOK_URL,

    // VCRED has 6 decimals: 100 VCRED = 100_000_000
    minSwapVcred: 100_000_000n,        // 100 VCRED
    maxSwapVcredCap: 100_000_000_000n, // 100,000 VCRED

    reconcileIntervalMs: 30_000,
    quotesTtlMs: 10_000,

    dataDir: optionalEnv('DATA_DIR', './data'),
    logsDir: optionalEnv('LOGS_DIR', './logs'),
  };
}
