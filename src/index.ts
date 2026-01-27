import { loadConfig } from './config.js';
import { initLogging, diag } from './logging.js';
import { initDb, acquireLock, releaseLock } from './db.js';
import { initClients } from './wallet.js';
import { startReconciler, stopReconciler } from './engine/reconciler.js';
import { startServer } from './server.js';

let reconcilerTimer: NodeJS.Timeout | null = null;

async function main(): Promise<void> {
  diag.info('keeper-arb starting');

  let lockAcquired = false;

  try {

  // Load config
  const config = loadConfig();
  diag.info('Config loaded', {
    hemiRpc: config.hemiRpcUrl,
    ethRpc: config.ethRpcUrl,
    dashboardPort: config.dashboardPort,
  });

  // Init logging
  initLogging(config.logsDir);

  // Init database
  initDb(config.dataDir);

  // Acquire single-instance lock
    if (!acquireLock()) {
      diag.error('Failed to acquire lock - another instance may be running');
      process.exit(1);
    }
    lockAcquired = true;

  // Init wallet and clients
  const clients = initClients(config);
  diag.info('Wallet connected', { address: clients.address });

  // Handle shutdown gracefully - wait for in-flight operations
    let shuttingDown = false;
    const shutdown = async () => {
      if (shuttingDown) return; // Prevent multiple shutdown calls
      shuttingDown = true;
      diag.info('Shutting down gracefully...');
      if (reconcilerTimer) {
        stopReconciler(reconcilerTimer);
      }
      // Wait for any pending reconciliation to complete
      diag.info('Waiting for pending operations to complete...');
      await new Promise(resolve => setTimeout(resolve, 2000));
      releaseLock();
      diag.info('Shutdown complete');
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

  // Start dashboard server
  await startServer(config, clients);

  // Start reconciler loop
  reconcilerTimer = startReconciler(clients, config);

  diag.info('keeper-arb running', {
    address: clients.address,
    dashboard: `http://localhost:${config.dashboardPort}`,
  });

  // Keep process alive
    await new Promise(() => {});
  } catch (err) {
    if (lockAcquired) {
      releaseLock();
    }
    throw err;
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
