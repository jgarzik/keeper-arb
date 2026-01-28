import { existsSync, mkdirSync, appendFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { CHAIN_ID_ETHEREUM, CHAIN_ID_HEMI } from './chains.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogEntry {
  ts: string;
  level: LogLevel;
  msg: string;
  data?: Record<string, unknown>;
}

interface MoneyLogEntry {
  ts: string;
  event: string;
  data: Record<string, unknown>;
}

export interface FormattedLogEntry {
  ts: string;
  level: LogLevel;
  msg: string;
  token?: string;
  chain?: string;
  amount?: string;
  txHash?: string;
  explorerUrl?: string;
  lzGuid?: string;
  lzScanUrl?: string;
  data?: Record<string, unknown>;
}

type LogSubscriber = (entry: FormattedLogEntry) => void;

let logsDir = './logs';

// In-memory ring buffers for streaming
const diagBuffer: FormattedLogEntry[] = [];
const moneyBuffer: FormattedLogEntry[] = [];
const diagSubscribers = new Set<LogSubscriber>();
const moneySubscribers = new Set<LogSubscriber>();
const MAX_BUFFER_SIZE = 500;

export function initLogging(dir: string): void {
  logsDir = dir;
  if (!existsSync(logsDir)) {
    mkdirSync(logsDir, { recursive: true });
  }

  // Load existing money.log into buffer
  const moneyLogPath = join(logsDir, 'money.log');
  if (existsSync(moneyLogPath)) {
    const content = readFileSync(moneyLogPath, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);
    // Take last MAX_BUFFER_SIZE lines
    const recent = lines.slice(-MAX_BUFFER_SIZE);
    for (const line of recent) {
      try {
        const entry = JSON.parse(line) as MoneyLogEntry;
        const formatted = formatLogEntry(
          { ts: entry.ts, level: 'info', msg: entry.event, data: entry.data },
          'money'
        );
        moneyBuffer.push(formatted); // oldest first during load
      } catch { /* skip malformed */ }
    }
    moneyBuffer.reverse(); // newest first
  }
}

function timestamp(): string {
  return new Date().toISOString();
}

function writeJsonLine(file: string, obj: unknown): void {
  const line = JSON.stringify(obj) + '\n';
  appendFileSync(join(logsDir, file), line);
}

// Diagnostic logger
export const diag = {
  debug(msg: string, data?: Record<string, unknown>): void {
    logDiag('debug', msg, data);
  },
  info(msg: string, data?: Record<string, unknown>): void {
    logDiag('info', msg, data);
  },
  warn(msg: string, data?: Record<string, unknown>): void {
    logDiag('warn', msg, data);
  },
  error(msg: string, data?: Record<string, unknown>): void {
    logDiag('error', msg, data);
  },
};

function logDiag(level: LogLevel, msg: string, data?: Record<string, unknown>): void {
  const entry: LogEntry = { ts: timestamp(), level, msg };
  if (data) entry.data = data;

  // Console output
  const prefix = `[${entry.ts}] [${level.toUpperCase()}]`;
  if (level === 'error') {
    console.error(prefix, msg, data ?? '');
  } else if (level === 'warn') {
    console.warn(prefix, msg, data ?? '');
  } else {
    console.log(prefix, msg, data ?? '');
  }

  // File output
  writeJsonLine('diag.log', entry);

  // Push to log bus
  const formatted = formatLogEntry(entry, 'diag');
  pushToBuffer(diagBuffer, formatted);
  notifySubscribers(diagSubscribers, formatted);
}

// Money-moves logger (append-only, critical financial events)
export function logMoney(event: string, data: Record<string, unknown>): void {
  const entry: MoneyLogEntry = { ts: timestamp(), event, data };
  writeJsonLine('money.log', entry);
  
  // Push to money log bus (don't duplicate to diag)
  const formatted = formatLogEntry({ ts: entry.ts, level: 'info', msg: event, data }, 'money');
  pushToBuffer(moneyBuffer, formatted);
  notifySubscribers(moneySubscribers, formatted);
}

// Format log entry for streaming
function formatLogEntry(entry: LogEntry | MoneyLogEntry, _source: 'diag' | 'money'): FormattedLogEntry {
  const data = 'data' in entry ? entry.data : undefined;
  const msg = 'msg' in entry ? entry.msg : ('event' in entry ? entry.event : '');
  const level: LogLevel = 'level' in entry ? entry.level : 'info';

  const formatted: FormattedLogEntry = {
    ts: entry.ts,
    level,
    msg,
  };

  if (data) {
    // Extract special fields
    if (data.token && typeof data.token === 'string') formatted.token = data.token;
    if (data.chainId && typeof data.chainId === 'number') {
      formatted.chain = data.chainId === CHAIN_ID_HEMI ? 'Hemi' : data.chainId === CHAIN_ID_ETHEREUM ? 'Ethereum' : `Chain ${data.chainId}`;
    }
    if (data.amount && typeof data.amount === 'string') formatted.amount = data.amount;
    if (data.txHash && typeof data.txHash === 'string') {
      formatted.txHash = data.txHash;
      // Generate explorer URL if we have chainId
      if (data.chainId && typeof data.chainId === 'number') {
        const chainId = data.chainId;
        if (chainId === CHAIN_ID_HEMI) {
          formatted.explorerUrl = `https://explorer.hemi.xyz/tx/${data.txHash}`;
        } else if (chainId === CHAIN_ID_ETHEREUM) {
          formatted.explorerUrl = `https://etherscan.io/tx/${data.txHash}`;
        }
      }
    }

    // Extract LayerZero GUID and generate scan URL
    if (data.lzGuid && typeof data.lzGuid === 'string') {
      formatted.lzGuid = data.lzGuid;
      formatted.lzScanUrl = `https://layerzeroscan.com/tx/${data.lzGuid}`;
    }

    // Keep remaining data but truncate large values
    const remainingData: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) {
      if (!['token', 'chainId', 'amount', 'txHash', 'lzGuid'].includes(key)) {
        if (typeof value === 'string' && value.length > 100) {
          remainingData[key] = value.slice(0, 100) + '...';
        } else if (typeof value === 'object' && value !== null) {
          remainingData[key] = '[Object]';
        } else {
          remainingData[key] = value;
        }
      }
    }
    if (Object.keys(remainingData).length > 0) {
      formatted.data = remainingData;
    }
  }

  return formatted;
}

function pushToBuffer(buffer: FormattedLogEntry[], entry: FormattedLogEntry): void {
  buffer.unshift(entry); // newest first
  if (buffer.length > MAX_BUFFER_SIZE) {
    buffer.pop();
  }
}

function notifySubscribers(subscribers: Set<LogSubscriber>, entry: FormattedLogEntry): void {
  for (const subscriber of subscribers) {
    try {
      subscriber(entry);
    } catch (err) {
      console.error('Log subscriber error:', err);
    }
  }
}

// Subscribe to log streams
export function subscribeDiagLogs(callback: LogSubscriber): () => void {
  diagSubscribers.add(callback);
  return () => diagSubscribers.delete(callback);
}

export function subscribeMoneyLogs(callback: LogSubscriber): () => void {
  moneySubscribers.add(callback);
  return () => moneySubscribers.delete(callback);
}

export function getDiagBuffer(): FormattedLogEntry[] {
  return [...diagBuffer];
}

export function getMoneyBuffer(): FormattedLogEntry[] {
  return [...moneyBuffer];
}
