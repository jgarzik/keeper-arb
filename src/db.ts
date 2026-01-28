import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'fs';
import { hostname } from 'os';
import { join } from 'path';
import { diag } from './logging.js';

export type CycleState =
  | 'DETECTED'
  | 'HEMI_SWAP_DONE'
  | 'BRIDGE_OUT_SENT'
  | 'BRIDGE_OUT_PROVE_REQUIRED'
  | 'BRIDGE_OUT_PROVED'
  | 'BRIDGE_OUT_FINALIZE_REQUIRED'
  | 'ON_ETHEREUM'
  | 'ETH_SWAP_DONE'
  | 'USDC_BRIDGE_BACK_SENT'
  | 'ON_HEMI_USDC'
  | 'HEMI_CLOSE_SWAP_DONE'
  | 'COMPLETED'
  | 'FAILED';

export type StepStatus = 'pending' | 'submitted' | 'confirmed' | 'failed';

export interface Cycle {
  id: number;
  token: string;
  vcredIn: string; // bigint as string
  xOut: string | null;
  usdcOut: string | null;
  vcredOut: string | null;
  state: CycleState;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Step {
  id: number;
  cycleId: number;
  stepType: string;
  chainId: number;
  txHash: string | null;
  status: StepStatus;
  gasUsed: string | null;
  gasPrice: string | null;
  error: string | null;
  withdrawalHash: string | null;
  withdrawalData: string | null; // JSON: {nonce, sender, target, value, gasLimit, data}
  lzGuid: string | null; // LayerZero message GUID for Stargate bridges
  createdAt: string;
  updatedAt: string;
}

export interface LedgerEntry {
  id: number;
  cycleId: number | null;
  stepId: number | null;
  entryType: string;
  chainId: number;
  token: string;
  amount: string;
  txHash: string | null;
  createdAt: string;
}

let db: Database.Database | null = null;

export function initDb(dataDir: string): Database.Database {
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }

  const dbPath = join(dataDir, 'keeper.db');
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  createSchema(db);

  // Migration: add withdrawalHash column to steps if missing
  const hasCol = db.prepare(
    "SELECT COUNT(*) as cnt FROM pragma_table_info('steps') WHERE name='withdrawalHash'"
  ).get() as { cnt: number };
  if (hasCol.cnt === 0) {
    db.exec('ALTER TABLE steps ADD COLUMN withdrawalHash TEXT');
  }

  // Migration: add withdrawalData column to steps if missing
  const hasWithdrawalData = db.prepare(
    "SELECT COUNT(*) as cnt FROM pragma_table_info('steps') WHERE name='withdrawalData'"
  ).get() as { cnt: number };
  if (hasWithdrawalData.cnt === 0) {
    db.exec('ALTER TABLE steps ADD COLUMN withdrawalData TEXT');
  }

  // Migration: add lzGuid column to steps if missing (LayerZero GUID for Stargate bridges)
  const hasLzGuid = db.prepare(
    "SELECT COUNT(*) as cnt FROM pragma_table_info('steps') WHERE name='lzGuid'"
  ).get() as { cnt: number };
  if (hasLzGuid.cnt === 0) {
    db.exec('ALTER TABLE steps ADD COLUMN lzGuid TEXT');
  }

  diag.info('Database initialized', { path: dbPath });
  return db;
}

export function getDb(): Database.Database {
  if (!db) {
    throw new Error('Database not initialized');
  }
  return db;
}

function createSchema(db: Database.Database): void {
  // Check if lock table needs migration (missing hostname column)
  // Lock table is transient (no persistent data), safe to drop and recreate
  const lockInfo = db.prepare(
    "SELECT COUNT(*) as cnt FROM pragma_table_info('lock') WHERE name='hostname'"
  ).get() as { cnt: number } | undefined;

  if (lockInfo && lockInfo.cnt === 0) {
    db.exec('DROP TABLE IF EXISTS lock');
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS cycles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token TEXT NOT NULL,
      vcredIn TEXT NOT NULL,
      xOut TEXT,
      usdcOut TEXT,
      vcredOut TEXT,
      state TEXT NOT NULL DEFAULT 'DETECTED',
      error TEXT,
      createdAt TEXT NOT NULL DEFAULT (datetime('now')),
      updatedAt TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS steps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cycleId INTEGER NOT NULL REFERENCES cycles(id),
      stepType TEXT NOT NULL,
      chainId INTEGER NOT NULL,
      txHash TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      gasUsed TEXT,
      gasPrice TEXT,
      error TEXT,
      withdrawalHash TEXT,
      withdrawalData TEXT,
      createdAt TEXT NOT NULL DEFAULT (datetime('now')),
      updatedAt TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cycleId INTEGER REFERENCES cycles(id),
      stepId INTEGER REFERENCES steps(id),
      entryType TEXT NOT NULL,
      chainId INTEGER NOT NULL,
      token TEXT NOT NULL,
      amount TEXT NOT NULL,
      txHash TEXT,
      createdAt TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS lock (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      lockedAt TEXT NOT NULL,
      pid INTEGER NOT NULL,
      hostname TEXT NOT NULL DEFAULT ''
    );

    CREATE INDEX IF NOT EXISTS idx_cycles_state ON cycles(state);
    CREATE INDEX IF NOT EXISTS idx_steps_cycle ON steps(cycleId);
    CREATE INDEX IF NOT EXISTS idx_ledger_cycle ON ledger(cycleId);
  `);
}

// Check if a process with given PID is running
function isProcessRunning(pid: number): boolean {
  try {
    // Sending signal 0 doesn't kill the process, just checks if it exists
    process.kill(pid, 0);
    return true;
  } catch {
    // ESRCH = no such process, EPERM = process exists but no permission
    return false;
  }
}

// Lock management for single-instance
export function acquireLock(): boolean {
  const d = getDb();
  const now = new Date().toISOString();
  const pid = process.pid;
  const host = hostname();

  try {
    d.exec('BEGIN EXCLUSIVE');
    const existing = d.prepare('SELECT * FROM lock WHERE id = 1').get() as
      { lockedAt: string; pid: number; hostname: string } | undefined;

    if (existing) {
      // Same host + running process = truly held lock
      if (existing.hostname === host && isProcessRunning(existing.pid)) {
        d.exec('ROLLBACK');
        diag.warn('Lock held by running process on same host', {
          pid: existing.pid, hostname: host
        });
        return false;
      }

      // Different host OR dead process = stale lock
      diag.info('Clearing stale lock', {
        oldPid: existing.pid,
        oldHost: existing.hostname,
        newHost: host,
        reason: existing.hostname !== host ? 'different host' : 'dead process'
      });
      d.prepare('DELETE FROM lock WHERE id = 1').run();
    }

    d.prepare('INSERT INTO lock (id, lockedAt, pid, hostname) VALUES (1, ?, ?, ?)')
      .run(now, pid, host);
    d.exec('COMMIT');
    diag.info('Lock acquired', { pid, hostname: host });
    return true;
  } catch (err) {
    d.exec('ROLLBACK');
    throw err;
  }
}

export function releaseLock(): void {
  const d = getDb();
  d.prepare('DELETE FROM lock WHERE id = 1').run();
  diag.info('Lock released');
}

// Cycle operations
export function createCycle(token: string, vcredIn: bigint): Cycle {
  const d = getDb();
  const result = d.prepare(`
    INSERT INTO cycles (token, vcredIn) VALUES (?, ?)
  `).run(token, vcredIn.toString());

  return getCycle(Number(result.lastInsertRowid))!;
}

export function getCycle(id: number): Cycle | undefined {
  const d = getDb();
  return d.prepare('SELECT * FROM cycles WHERE id = ?').get(id) as Cycle | undefined;
}

export function updateCycleState(id: number, state: CycleState, error?: string): void {
  const d = getDb();
  const now = new Date().toISOString();
  d.prepare(`
    UPDATE cycles SET state = ?, error = ?, updatedAt = ? WHERE id = ?
  `).run(state, error ?? null, now, id);
}

export function updateCycleAmounts(
  id: number,
  updates: { xOut?: bigint; usdcOut?: bigint; vcredOut?: bigint }
): void {
  const d = getDb();
  const now = new Date().toISOString();
  const sets: string[] = ['updatedAt = ?'];
  const values: (string | null)[] = [now];

  if (updates.xOut !== undefined) {
    sets.push('xOut = ?');
    values.push(updates.xOut.toString());
  }
  if (updates.usdcOut !== undefined) {
    sets.push('usdcOut = ?');
    values.push(updates.usdcOut.toString());
  }
  if (updates.vcredOut !== undefined) {
    sets.push('vcredOut = ?');
    values.push(updates.vcredOut.toString());
  }

  values.push(id.toString());
  d.prepare(`UPDATE cycles SET ${sets.join(', ')} WHERE id = ?`).run(...values);
}

export function getActiveCycles(): Cycle[] {
  const d = getDb();
  return d.prepare(`
    SELECT * FROM cycles WHERE state NOT IN ('COMPLETED', 'FAILED') ORDER BY createdAt
  `).all() as Cycle[];
}

export function getRecentCycles(limit: number = 50): Cycle[] {
  const d = getDb();
  return d.prepare(`
    SELECT * FROM cycles ORDER BY createdAt DESC LIMIT ?
  `).all(limit) as Cycle[];
}

// Step operations
export function createStep(cycleId: number, stepType: string, chainId: number): Step {
  const d = getDb();
  const result = d.prepare(`
    INSERT INTO steps (cycleId, stepType, chainId) VALUES (?, ?, ?)
  `).run(cycleId, stepType, chainId);

  return getStep(Number(result.lastInsertRowid))!;
}

export function getStep(id: number): Step | undefined {
  const d = getDb();
  return d.prepare('SELECT * FROM steps WHERE id = ?').get(id) as Step | undefined;
}

export function updateStep(
  id: number,
  updates: { txHash?: string; status?: StepStatus; gasUsed?: bigint; gasPrice?: bigint; error?: string; withdrawalHash?: string; withdrawalData?: string; lzGuid?: string }
): void {
  const d = getDb();
  const now = new Date().toISOString();
  const sets: string[] = ['updatedAt = ?'];
  const values: (string | null)[] = [now];

  if (updates.txHash !== undefined) {
    sets.push('txHash = ?');
    values.push(updates.txHash);
  }
  if (updates.status !== undefined) {
    sets.push('status = ?');
    values.push(updates.status);
  }
  if (updates.gasUsed !== undefined) {
    sets.push('gasUsed = ?');
    values.push(updates.gasUsed.toString());
  }
  if (updates.gasPrice !== undefined) {
    sets.push('gasPrice = ?');
    values.push(updates.gasPrice.toString());
  }
  if (updates.error !== undefined) {
    sets.push('error = ?');
    values.push(updates.error);
  }
  if (updates.withdrawalHash !== undefined) {
    sets.push('withdrawalHash = ?');
    values.push(updates.withdrawalHash);
  }
  if (updates.withdrawalData !== undefined) {
    sets.push('withdrawalData = ?');
    values.push(updates.withdrawalData);
  }
  if (updates.lzGuid !== undefined) {
    sets.push('lzGuid = ?');
    values.push(updates.lzGuid);
  }

  values.push(id.toString());
  d.prepare(`UPDATE steps SET ${sets.join(', ')} WHERE id = ?`).run(...values);
}

export function getStepsForCycle(cycleId: number): Step[] {
  const d = getDb();
  return d.prepare('SELECT * FROM steps WHERE cycleId = ? ORDER BY createdAt').all(cycleId) as Step[];
}

// Ledger operations
export function addLedgerEntry(
  entryType: string,
  chainId: number,
  token: string,
  amount: bigint,
  cycleId?: number,
  stepId?: number,
  txHash?: string
): void {
  const d = getDb();
  d.prepare(`
    INSERT INTO ledger (cycleId, stepId, entryType, chainId, token, amount, txHash)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(cycleId ?? null, stepId ?? null, entryType, chainId, token, amount.toString(), txHash ?? null);
}

export function getLedgerEntriesForCycle(cycleId: number): LedgerEntry[] {
  const d = getDb();
  return d.prepare('SELECT * FROM ledger WHERE cycleId = ? ORDER BY createdAt').all(cycleId) as LedgerEntry[];
}
