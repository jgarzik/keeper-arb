import { existsSync, mkdirSync, appendFileSync } from 'fs';
import { join } from 'path';

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

let logsDir = './logs';

export function initLogging(dir: string): void {
  logsDir = dir;
  if (!existsSync(logsDir)) {
    mkdirSync(logsDir, { recursive: true });
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
}

// Money-moves logger (append-only, critical financial events)
export function logMoney(event: string, data: Record<string, unknown>): void {
  const entry: MoneyLogEntry = { ts: timestamp(), event, data };
  writeJsonLine('money.log', entry);
  // Also log to diag for visibility
  diag.info(`[MONEY] ${event}`, data);
}
