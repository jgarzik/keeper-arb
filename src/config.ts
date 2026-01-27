import 'dotenv/config';
import { RPC_URLS } from './rpc.js';

export interface Config {
  // RPC endpoints
  hemiRpcUrl: string;
  ethRpcUrl: string;

  // Wallet (loaded once, never logged)
  walletPrivateKey?: string;
  walletMnemonic?: string;

  // Dashboard
  dashboardPort: number;
  dashboardPassword: string;

  // Notifications
  webhookUrl?: string;

  // Trading limits
  minSwapVcred: bigint;
  maxSwapVcredCap: bigint;
  minProfitVcred: bigint;

  // Timing
  reconcileIntervalMs: number;
  quotesTtlMs: number;

  // Paths
  dataDir: string;
  logsDir: string;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optionalEnv(name: string, defaultValue: string): string {
  return process.env[name] ?? defaultValue;
}

function parseBigInt(value: string): bigint {
  return BigInt(value);
}

export function loadConfig(): Config {
  const privateKey = process.env.ARBITRAGE_PRIVATE_KEY;
  const mnemonic = process.env.ARBITRAGE_MNEMONIC;
  if (!privateKey && !mnemonic) {
    throw new Error('Either ARBITRAGE_PRIVATE_KEY or ARBITRAGE_MNEMONIC must be set');
  }

  return {
    hemiRpcUrl: process.env.HEMI_RPC_URL || RPC_URLS.hemi,
    ethRpcUrl: process.env.ETH_RPC_URL || RPC_URLS.ethereum,

    walletPrivateKey: privateKey,
    walletMnemonic: mnemonic,

    dashboardPort: parseInt(optionalEnv('DASHBOARD_PORT', '3000'), 10),
    dashboardPassword: requireEnv('DASHBOARD_PASSWORD'),

    webhookUrl: process.env.WEBHOOK_URL,

    minSwapVcred: parseBigInt(optionalEnv('MIN_SWAP_VCRED', '100')),
    maxSwapVcredCap: parseBigInt(optionalEnv('MAX_SWAP_VCRED_CAP', '100000')),
    minProfitVcred: parseBigInt(optionalEnv('MIN_PROFIT_VCRED', '0')),

    reconcileIntervalMs: parseInt(optionalEnv('RECONCILE_INTERVAL_MS', '30000'), 10),
    quotesTtlMs: parseInt(optionalEnv('QUOTES_TTL_MS', '10000'), 10),

    dataDir: optionalEnv('DATA_DIR', './data'),
    logsDir: optionalEnv('LOGS_DIR', './logs'),
  };
}
