import Fastify from 'fastify';
import fastifyBasicAuth from '@fastify/basic-auth';
import fastifyStatic from '@fastify/static';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';
import { type Config } from './config.js';
import { type Clients, getAllBalances, formatBalance } from './wallet.js';
import { getActiveCycles, getRecentCycles, getStepsForCycle } from './db.js';
import {
  getReconcilerState,
  pauseAll,
  resumeAll,
  pauseToken,
  resumeToken,
} from './engine/reconciler.js';
import { calculateLifetimePnL, calculateDailyPnL, formatVcred, formatEth } from './engine/accounting.js';
import { TOKENS, type TokenId } from './tokens.js';
import { getExplorerTxUrl } from './chains.js';
import { diag } from './logging.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function startServer(config: Config, clients: Clients): Promise<void> {
  const fastify = Fastify({ logger: false });

  // Basic auth
  await fastify.register(fastifyBasicAuth, {
    validate: async (username, password) => {
      if (password !== config.dashboardPassword) {
        throw new Error('Invalid password');
      }
    },
    authenticate: true,
  });

  // Protect all routes
  fastify.addHook('onRequest', fastify.basicAuth);

  // API routes
  fastify.get('/api/status', async () => {
    const reconciler = getReconcilerState();
    const activeCycles = getActiveCycles();

    return {
      running: reconciler.running,
      paused: reconciler.paused,
      pausedTokens: Array.from(reconciler.pausedTokens),
      lastRun: reconciler.lastRun?.toISOString() ?? null,
      activeCycles: activeCycles.length,
    };
  });

  fastify.get('/api/balances', async () => {
    const balances = await getAllBalances(clients);
    return balances.map((b) => ({
      chainId: b.chainId,
      native: formatEth(b.native),
      tokens: Object.fromEntries(
        Object.entries(b.tokens).map(([k, v]) => [
          k,
          formatBalance(v, TOKENS[k as TokenId].decimals),
        ])
      ),
    }));
  });

  fastify.get('/api/cycles', async () => {
    const cycles = getRecentCycles(50);
    return cycles.map((c) => ({
      id: c.id,
      token: c.token,
      vcredIn: c.vcredIn,
      xOut: c.xOut,
      usdcOut: c.usdcOut,
      vcredOut: c.vcredOut,
      state: c.state,
      error: c.error,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
    }));
  });

  fastify.get<{ Params: { id: string } }>('/api/cycles/:id', async (req) => {
    const cycleId = parseInt(req.params.id, 10);
    const cycles = getRecentCycles(1000);
    const cycle = cycles.find((c) => c.id === cycleId);

    if (!cycle) {
      throw { statusCode: 404, message: 'Cycle not found' };
    }

    const steps = getStepsForCycle(cycleId);

    return {
      ...cycle,
      steps: steps.map((s) => ({
        ...s,
        explorerUrl: s.txHash ? getExplorerTxUrl(s.chainId, s.txHash) : null,
      })),
    };
  });

  fastify.get('/api/pnl', async () => {
    const lifetime = calculateLifetimePnL();
    const today = new Date().toISOString().slice(0, 10);
    const daily = calculateDailyPnL(today);

    return {
      lifetime: {
        cyclesCompleted: lifetime.cyclesCompleted,
        cyclesFailed: lifetime.cyclesFailed,
        totalVcredSold: formatVcred(lifetime.totalVcredSold),
        totalVcredRegained: formatVcred(lifetime.totalVcredRegained),
        grossProfit: formatVcred(lifetime.grossProfit),
        totalGasHemi: formatEth(lifetime.totalGasHemi),
        totalGasEth: formatEth(lifetime.totalGasEth),
        netProfit: formatVcred(lifetime.netProfit),
      },
      today: {
        date: daily.date,
        cyclesCompleted: daily.cyclesCompleted,
        totalVcredSold: formatVcred(daily.totalVcredSold),
        totalVcredRegained: formatVcred(daily.totalVcredRegained),
        grossProfit: formatVcred(daily.grossProfit),
        netProfit: formatVcred(daily.netProfit),
      },
    };
  });

  // Control endpoints
  fastify.post('/api/pause', async () => {
    pauseAll();
    return { success: true, paused: true };
  });

  fastify.post('/api/resume', async () => {
    resumeAll();
    return { success: true, paused: false };
  });

  fastify.post<{ Body: { token: string } }>('/api/pause-token', async (req) => {
    const token = req.body.token as TokenId;
    pauseToken(token);
    return { success: true, token, paused: true };
  });

  fastify.post<{ Body: { token: string } }>('/api/resume-token', async (req) => {
    const token = req.body.token as TokenId;
    resumeToken(token);
    return { success: true, token, paused: false };
  });

  // Serve static dashboard files if they exist
  const dashboardPath = join(__dirname, '../dashboard/dist');
  if (existsSync(dashboardPath)) {
    await fastify.register(fastifyStatic, {
      root: dashboardPath,
      prefix: '/',
    });
  } else {
    // Simple HTML page if dashboard not built
    fastify.get('/', async (_, reply) => {
      reply.type('text/html');
      return `
<!DOCTYPE html>
<html>
<head>
  <title>keeper-arb Dashboard</title>
  <style>
    body { font-family: monospace; padding: 20px; background: #1a1a1a; color: #0f0; }
    pre { background: #000; padding: 10px; border-radius: 4px; overflow: auto; }
    h1 { color: #0f0; }
    a { color: #0ff; }
  </style>
</head>
<body>
  <h1>keeper-arb Dashboard</h1>
  <p>API endpoints:</p>
  <ul>
    <li><a href="/api/status">/api/status</a> - Reconciler status</li>
    <li><a href="/api/balances">/api/balances</a> - Wallet balances</li>
    <li><a href="/api/cycles">/api/cycles</a> - Recent cycles</li>
    <li><a href="/api/pnl">/api/pnl</a> - P&L summary</li>
  </ul>
  <p>Build the React dashboard: <code>cd dashboard && npm run build</code></p>
</body>
</html>
      `;
    });
  }

  // Start server
  await fastify.listen({ port: config.dashboardPort, host: '0.0.0.0' });
  diag.info('Dashboard server started', { port: config.dashboardPort });
}
