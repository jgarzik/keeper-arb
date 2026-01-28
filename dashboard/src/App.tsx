import React, { useState, useEffect, useRef } from 'react';

const ARB_TARGET_TOKENS = ['WETH', 'WBTC', 'hemiBTC', 'cbBTC', 'XAUt', 'VUSD'];

interface Status {
  running: boolean;
  paused: boolean;
  pausedTokens: string[];
  lastRun: string | null;
  activeCycles: number;
}

interface Balance {
  chainId: number;
  native: string;
  tokens: Record<string, string>;
}

interface Cycle {
  id: number;
  token: string;
  vcredIn: string;
  xOut: string | null;
  usdcOut: string | null;
  vcredOut: string | null;
  state: string;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

interface StepDetail {
  id: number;
  stepType: string;
  chainId: number;
  txHash: string | null;
  status: 'pending' | 'submitted' | 'confirmed' | 'failed';
  gasUsed: string | null;
  gasPrice: string | null;
  explorerUrl: string | null;
}

interface CycleDetail extends Cycle {
  steps: StepDetail[];
}

interface PnL {
  lifetime: {
    cyclesCompleted: number;
    cyclesFailed: number;
    totalVcredSold: string;
    totalVcredRegained: string;
    grossProfit: string;
    totalGasHemi: string;
    totalGasEth: string;
    netProfit: string;
  };
  today: {
    date: string;
    cyclesCompleted: number;
    totalVcredSold: string;
    totalVcredRegained: string;
    grossProfit: string;
    netProfit: string;
  };
}

interface LogEntry {
  ts: string;
  level: 'debug' | 'info' | 'warn' | 'error';
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

interface ProviderHealth {
  provider: string;
  status: 'ok' | 'degraded' | 'error';
  latencyMs: number;
  error?: string;
  details?: Record<string, unknown>;
}

interface HealthCheckResult {
  timestamp: string;
  providers: ProviderHealth[];
  summary: {
    total: number;
    ok: number;
    degraded: number;
    error: number;
  };
}

type Tab = 'status' | 'cycles' | 'pnl' | 'diagnostics';
type LogType = 'diag' | 'money';

interface TokenMeta {
  symbol: string;
  decimals: Record<number, number>;
  addresses: Record<number, string>;
}

async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

function App() {
  const [tab, setTab] = useState<Tab>('status');
  const [status, setStatus] = useState<Status | null>(null);
  const [balances, setBalances] = useState<Balance[]>([]);
  const [cycles, setCycles] = useState<Cycle[]>([]);
  const [pnl, setPnl] = useState<PnL | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expandedCycles, setExpandedCycles] = useState<Set<number>>(new Set());
  const [cycleSteps, setCycleSteps] = useState<Map<number, CycleDetail>>(new Map());
  const [loadingCycles, setLoadingCycles] = useState<Set<number>>(new Set());
  const [togglingTokens, setTogglingTokens] = useState<Set<string>>(new Set());

  // Logs state
  const [logType, setLogType] = useState<LogType>('diag');
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [logsPaused, setLogsPaused] = useState(false);
  const [logFilter, setLogFilter] = useState('');
  const [levelFilter, setLevelFilter] = useState<'all' | 'debug' | 'info' | 'warn' | 'error'>('all');
  const [expandedLogs, setExpandedLogs] = useState<Set<number>>(new Set());
  const [missedLogCount, setMissedLogCount] = useState(0);
  const logContainerRef = useRef<HTMLDivElement>(null);

  // Token metadata for authoritative decimals
  const [tokenMeta, setTokenMeta] = useState<Record<string, TokenMeta>>({});

  // Provider health check state
  const [healthResult, setHealthResult] = useState<HealthCheckResult | null>(null);
  const [healthLoading, setHealthLoading] = useState(false);

  const refresh = async () => {
    try {
      const [s, b, c, p] = await Promise.all([
        api<Status>('/status'),
        api<Balance[]>('/balances'),
        api<Cycle[]>('/cycles'),
        api<PnL>('/pnl'),
      ]);
      setStatus(s);
      setBalances(b);
      setCycles(c);
      setPnl(p);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  };

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 60000);
    return () => clearInterval(interval);
  }, []);

  // Fetch token metadata once on mount
  useEffect(() => {
    api<Record<string, TokenMeta>>('/tokens').then(setTokenMeta).catch(() => {});
  }, []);

  // SSE log streaming
  useEffect(() => {
    let eventSource: EventSource | null = null;
    let reconnectTimeout: NodeJS.Timeout | null = null;
    let reconnectAttempts = 0;

    const connect = () => {
      eventSource = new EventSource(`/api/logs/stream?type=${logType}`);

      eventSource.onmessage = (event) => {
        if (logsPaused) {
          setMissedLogCount((prev) => prev + 1);
          return;
        }

        try {
          const entry: LogEntry = JSON.parse(event.data);
          setLogs((prev) => {
            const updated = [entry, ...prev];
            return updated.slice(0, 500); // Keep max 500 entries
          });
        } catch (err) {
          console.error('Failed to parse log entry:', err);
        }
      };

      eventSource.onerror = () => {
        eventSource?.close();
        reconnectAttempts++;
        const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000);
        reconnectTimeout = setTimeout(connect, delay);
      };

      eventSource.onopen = () => {
        reconnectAttempts = 0;
      };
    };

    connect();

    return () => {
      eventSource?.close();
      if (reconnectTimeout) clearTimeout(reconnectTimeout);
    };
  }, [logType, logsPaused]);

  const clearLogs = () => {
    setLogs([]);
  };

  const handleLogScroll = () => {
    const container = logContainerRef.current;
    if (!container) return;

    // User scrolled down > 50px from top → auto-pause
    const isAtTop = container.scrollTop < 50;
    if (!isAtTop && !logsPaused) {
      setLogsPaused(true);
    }
  };

  const jumpToLatest = () => {
    setLogsPaused(false);
    setMissedLogCount(0);
    logContainerRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const filteredLogs = logs.filter((log) => {
    if (levelFilter !== 'all' && log.level !== levelFilter) return false;
    if (logFilter) {
      const searchLower = logFilter.toLowerCase();
      return (
        log.msg.toLowerCase().includes(searchLower) ||
        log.token?.toLowerCase().includes(searchLower) ||
        log.chain?.toLowerCase().includes(searchLower) ||
        log.txHash?.toLowerCase().includes(searchLower)
      );
    }
    return true;
  });

  const togglePause = async () => {
    if (status?.paused) {
      await api('/resume', 'POST');
    } else {
      await api('/pause', 'POST');
    }
    refresh();
  };

  const toggleExpand = async (cycleId: number) => {
    const newExpanded = new Set(expandedCycles);
    if (newExpanded.has(cycleId)) {
      newExpanded.delete(cycleId);
      setExpandedCycles(newExpanded);
      return;
    }
    newExpanded.add(cycleId);
    setExpandedCycles(newExpanded);

    // Fetch steps if not already cached
    if (!cycleSteps.has(cycleId)) {
      setLoadingCycles((prev) => new Set(prev).add(cycleId));
      try {
        const detail = await api<CycleDetail>(`/cycles/${cycleId}`);
        setCycleSteps((prev) => new Map(prev).set(cycleId, detail));
      } catch (e) {
        setError(`Failed to load cycle ${cycleId}: ${e}`);
      } finally {
        setLoadingCycles((prev) => {
          const next = new Set(prev);
          next.delete(cycleId);
          return next;
        });
      }
    }
  };

  const toggleToken = async (token: string) => {
    const isPaused = status?.pausedTokens.includes(token);
    setTogglingTokens((prev) => new Set(prev).add(token));
    try {
      if (isPaused) {
        await api('/resume-token', 'POST', { token });
      } else {
        await api('/pause-token', 'POST', { token });
      }
      await refresh();
    } catch (e) {
      setError(`Failed to toggle ${token}: ${e}`);
    } finally {
      setTogglingTokens((prev) => {
        const next = new Set(prev);
        next.delete(token);
        return next;
      });
    }
  };

  const runHealthCheck = async () => {
    setHealthLoading(true);
    try {
      const result = await api<HealthCheckResult>('/providers/health');
      setHealthResult(result);
    } catch (e) {
      setError(`Health check failed: ${e}`);
    } finally {
      setHealthLoading(false);
    }
  };

  const formatGas = (gas: string | null): string => {
    if (!gas) return '-';
    const num = parseInt(gas, 10);
    if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(2)}M`;
    if (num >= 1_000) return `${(num / 1_000).toFixed(1)}K`;
    return gas;
  };

  const formatGwei = (price: string | null): string => {
    if (!price) return '-';
    const gwei = parseFloat(price) / 1e9;
    return `${gwei.toFixed(2)} gwei`;
  };

  const chainName = (id: number) => (id === 43111 ? 'Hemi' : id === 1 ? 'Ethereum' : `Chain ${id}`);

  const toggleLogExpand = (index: number) => {
    const newExpanded = new Set(expandedLogs);
    if (newExpanded.has(index)) {
      newExpanded.delete(index);
    } else {
      newExpanded.add(index);
    }
    setExpandedLogs(newExpanded);
  };

  // Pure string formatting - no floating point conversion
  const formatBigIntString = (value: string | undefined, decimals: number, precision = 4): string => {
    if (!value) return '?';

    const isNegative = value.startsWith('-');
    let absValue = isNegative ? value.slice(1) : value;

    // Remove any non-digit characters
    absValue = absValue.replace(/[^0-9]/g, '');
    if (!absValue || absValue === '') return '?';

    // Pad if shorter than decimals
    while (absValue.length <= decimals) {
      absValue = '0' + absValue;
    }

    const splitPoint = absValue.length - decimals;
    const whole = absValue.slice(0, splitPoint) || '0';
    const frac = absValue.slice(splitPoint, splitPoint + precision).padEnd(precision, '0');

    const sign = isNegative ? '-' : '';
    return `${sign}${whole}.${frac}`;
  };

  // Build address → decimals lookup from tokenMeta
  const addressDecimals = React.useMemo(() => {
    const map: Record<string, number> = {};
    for (const meta of Object.values(tokenMeta)) {
      for (const [chainIdStr, addr] of Object.entries(meta.addresses || {})) {
        const chainId = Number(chainIdStr);
        const decimals = meta.decimals[chainId];
        if (addr && decimals !== undefined) {
          map[addr.toLowerCase()] = decimals;
        }
      }
    }
    return map;
  }, [tokenMeta]);

  // Build address → symbol lookup from tokenMeta
  const addressSymbols = React.useMemo(() => {
    const map: Record<string, string> = {};
    for (const [symbol, meta] of Object.entries(tokenMeta)) {
      for (const addr of Object.values(meta.addresses || {})) {
        if (addr) {
          map[addr.toLowerCase()] = symbol;
        }
      }
    }
    return map;
  }, [tokenMeta]);

  // Get symbol from address, with fallback
  const getSymbol = (addr: string | undefined): string => {
    if (!addr) return '?';
    if (!addr.startsWith('0x')) return addr; // Already a symbol
    const addrLower = addr.toLowerCase();
    if (addressSymbols[addrLower]) return addressSymbols[addrLower];
    // Fallback for known addresses
    const knownSymbols: Record<string, string> = {
      '0x71881974e96152643c74a8e0214b877cfb2a0aa1': 'VCRED',
      '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': 'USDC',
      '0xad11a8beb98bbf61dbb1aa0f6d6f2ecd87b35afa': 'USDC',
      '0x68749665ff8d2d112fa859aa293f07a622782f38': 'XAUt',
      '0x028de74e2fe336511a8e5fab0426d1cfd5110dbb': 'XAUt',
      '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2': 'WETH',
      '0x4200000000000000000000000000000000000006': 'WETH',
      '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599': 'WBTC',
      '0x03c7054bcb39f7b2e5b2c7acb37583e32d70cfa3': 'WBTC',
      '0xaa40c0c7644e0b2b224509571e10ad20d9c4ef28': 'hemiBTC',
      '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf': 'cbBTC',
      '0x1596be338b999e2376675c908168a7548c8b0525': 'cbBTC',
    };
    return knownSymbols[addrLower] || addr.slice(0, 8);
  };

  // Get decimals from API metadata, with fallback
  // Accepts either token symbol (VCRED) or address (0x...)
  const getDecimals = (token: string | undefined, chainId?: number): number => {
    if (!token) return 18;

    // Check if it's an address (starts with 0x)
    if (token.startsWith('0x')) {
      const addrLower = token.toLowerCase();
      if (addressDecimals[addrLower] !== undefined) {
        return addressDecimals[addrLower];
      }
      // Fallback for known addresses if API not loaded
      const knownAddrs: Record<string, number> = {
        '0x71881974e96152643c74a8e0214b877cfb2a0aa1': 6, // VCRED
        '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': 6, // USDC Eth
        '0xad11a8beb98bbf61dbb1aa0f6d6f2ecd87b35afa': 6, // USDC Hemi
        '0x68749665ff8d2d112fa859aa293f07a622782f38': 6, // XAUt Eth
        '0x028de74e2fe336511a8e5fab0426d1cfd5110dbb': 6, // XAUt Hemi
        '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2': 18, // WETH Eth
        '0x4200000000000000000000000000000000000006': 18, // WETH Hemi
        '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599': 8, // WBTC Eth
        '0x03c7054bcb39f7b2e5b2c7acb37583e32d70cfa3': 8, // WBTC Hemi
        '0xaa40c0c7644e0b2b224509571e10ad20d9c4ef28': 8, // hemiBTC
        '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf': 8, // cbBTC Eth
        '0x1596be338b999e2376675c908168a7548c8b0525': 8, // cbBTC Hemi
      };
      if (knownAddrs[addrLower] !== undefined) {
        return knownAddrs[addrLower];
      }
      return 18; // Default for unknown addresses
    }

    // Symbol lookup
    const t = token.toUpperCase();
    if (tokenMeta[t]?.decimals) {
      if (chainId && tokenMeta[t].decimals[chainId]) return tokenMeta[t].decimals[chainId];
      const vals = Object.values(tokenMeta[t].decimals);
      if (vals.length > 0) return vals[0];
    }
    // Fallback if API not loaded yet
    if (t === 'VCRED' || t === 'USDC' || t === 'XAUT') return 6;
    if (t === 'WBTC' || t === 'HEMIBTC' || t === 'CBBTC') return 8;
    return 18;
  };

  const formatMonetarySummary = (log: LogEntry): string | null => {
    if (!log.data) return null;
    const data = log.data as Record<string, any>;

    // "Opportunity check" - show input → token (Hemi vs Ethereum comparison)
    // Format: "1000 VCRED → WETH (0.005 Hemi vs 0.006 Ethereum)"
    if (log.msg === 'Opportunity check') {
      const token = data.tokenId || 'X';
      const hemiOut = formatBigIntString(String(data.hemiOut), getDecimals(token));
      const ethOut = formatBigIntString(String(data.ethRefOut), getDecimals(token));
      return `→ ${token} (${hemiOut} Hemi vs ${ethOut} Eth) ${data.discount}`;
    }

    // "Profit estimate" - show the full cycle flow
    if (log.msg === 'Profit estimate') {
      const vcredIn = formatBigIntString(String(data.vcredIn), getDecimals('VCRED'));
      const xOut = formatBigIntString(String(data.xOut), getDecimals(data.token));
      const usdcOut = formatBigIntString(String(data.usdcOut), getDecimals('USDC'));
      const vcredOut = formatBigIntString(String(data.vcredOut), getDecimals('VCRED'));
      const netProfit = formatBigIntString(String(data.netProfitVcred), getDecimals('VCRED'));
      const token = data.token || 'X';
      return `${vcredIn} VCRED → ${xOut} ${token} → ${usdcOut} USDC → ${vcredOut} VCRED (net: ${netProfit})`;
    }

    // "Best swap quote selected" - show the winning quote
    if (log.msg === 'Best swap quote selected') {
      const chain = data.chainId === 43111 ? 'Hemi' : data.chainId === 1 ? 'Eth' : '';
      const symbolIn = getSymbol(data.tokenIn);
      const symbolOut = getSymbol(data.tokenOut);
      const amountIn = formatBigIntString(String(data.amountIn), getDecimals(data.tokenIn));
      const amountOut = formatBigIntString(String(data.amountOut), getDecimals(data.tokenOut));
      return `${amountIn} ${symbolIn} → ${amountOut} ${symbolOut} (${chain})`;
    }

    // "Sushi API quote" / "Eisen API quote" - show individual quote
    if (log.msg === 'Sushi API quote' || log.msg === 'Eisen API quote') {
      const chain = data.chainId === 43111 ? 'Hemi' : data.chainId === 1 ? 'Eth' : '';
      const symbolIn = getSymbol(data.tokenIn);
      const symbolOut = getSymbol(data.tokenOut);
      const amountIn = formatBigIntString(String(data.amountIn), getDecimals(data.tokenIn));
      const amountOut = formatBigIntString(String(data.amountOut), getDecimals(data.tokenOut));
      const impact = data.priceImpact ? ` ${(Number(data.priceImpact) * 100).toFixed(1)}%` : '';
      return `${amountIn} ${symbolIn} → ${amountOut} ${symbolOut} (${chain}${impact})`;
    }

    // "Optimal size found" - show optimal trade sizing result
    if (log.msg === 'Optimal size found') {
      const vcredIn = formatBigIntString(String(data.vcredIn), getDecimals('VCRED'));
      const profit = formatBigIntString(String(data.profit), getDecimals('VCRED'));
      const token = data.token || '';
      return `${token}: ${vcredIn} VCRED → profit ${profit} VCRED`;
    }

    // Step events - human-readable summaries
    if (log.msg === 'HEMI_SWAP') {
      const vcredIn = formatBigIntString(String(data.vcredIn), getDecimals('VCRED'));
      const xOut = formatBigIntString(String(data.xOut), getDecimals(data.token));
      const token = data.token || 'X';
      return `swap ${vcredIn} VCRED → ${xOut} ${token}`;
    }

    if (log.msg === 'ETH_SWAP') {
      const tokenIn = formatBigIntString(String(data.tokenIn || data.xIn), getDecimals(data.token));
      const usdcOut = formatBigIntString(String(data.usdcOut), getDecimals('USDC'));
      const token = data.token || 'X';
      return `swap ${tokenIn} ${token} → ${usdcOut} USDC`;
    }

    if (log.msg === 'BRIDGE_OUT') {
      const amount = formatBigIntString(String(data.amount || data.xOut), getDecimals(data.token));
      const token = data.token || 'X';
      return `bridge ${amount} ${token} Hemi → Ethereum`;
    }

    if (log.msg === 'BRIDGE_BACK') {
      const amount = formatBigIntString(String(data.amount || data.usdcAmount), getDecimals('USDC'));
      return `bridge ${amount} USDC Ethereum → Hemi`;
    }

    if (log.msg === 'CLOSE_SWAP') {
      const usdcIn = formatBigIntString(String(data.usdcIn), getDecimals('USDC'));
      const vcredOut = formatBigIntString(String(data.vcredOut), getDecimals('VCRED'));
      return `swap ${usdcIn} USDC → ${vcredOut} VCRED`;
    }

    if (log.msg === 'BRIDGE_PROVE') {
      const token = data.token || 'X';
      return `prove ${token} withdrawal`;
    }

    if (log.msg === 'BRIDGE_FINALIZE') {
      const token = data.token || 'X';
      return `finalize ${token} withdrawal`;
    }

    if (log.msg === 'CYCLE_CREATED') {
      const vcredIn = formatBigIntString(String(data.vcredIn), getDecimals('VCRED'));
      const token = data.token || 'X';
      return `new cycle: ${vcredIn} VCRED → ${token}`;
    }

    if (log.msg === 'CYCLE_COMPLETE') {
      const netProfit = formatBigIntString(String(data.netProfit || data.netProfitVcred), getDecimals('VCRED'));
      return `done: ${netProfit} VCRED net`;
    }

    return null;
  };

  // Compute in-flight tokens from active cycles
  const activeCyclesList = cycles.filter((c) => c.state !== 'COMPLETED' && c.state !== 'FAILED');
  const inFlightTokens = [...new Set(activeCyclesList.map((c) => c.token))];
  const stateBreakdown = activeCyclesList.reduce((acc, c) => {
    acc[c.state] = (acc[c.state] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  return (
    <div className="container">
      <h1>keeper-arb Dashboard</h1>

      {error && <div className="card" style={{ borderColor: '#da3633' }}>{error}</div>}

      <div className="tabs">
        <button className={`tab ${tab === 'status' ? 'active' : ''}`} onClick={() => setTab('status')}>
          Status
        </button>
        <button className={`tab ${tab === 'cycles' ? 'active' : ''}`} onClick={() => setTab('cycles')}>
          Cycles
        </button>
        <button className={`tab ${tab === 'pnl' ? 'active' : ''}`} onClick={() => setTab('pnl')}>
          P&L
        </button>
        <button className={`tab ${tab === 'diagnostics' ? 'active' : ''}`} onClick={() => setTab('diagnostics')}>
          Diagnostics
        </button>
      </div>

      {tab === 'status' && (
        <>
          <div className="card">
            <h2>Reconciler Status</h2>
            <div style={{ display: 'flex', alignItems: 'center', gap: '16px', marginTop: '12px' }}>
              <span className={`status-badge ${status?.paused ? 'status-paused' : 'status-running'}`}>
                {status?.paused ? 'PAUSED' : 'RUNNING'}
              </span>
              <span>Active Cycles: {status?.activeCycles ?? 0}</span>
              <span>Last Run: {status?.lastRun ? new Date(status.lastRun).toLocaleTimeString() : 'Never'}</span>
              <button className={`btn ${status?.paused ? 'btn-success' : 'btn-danger'}`} onClick={togglePause}>
                {status?.paused ? 'Resume' : 'Pause'}
              </button>
            </div>
          </div>

          <div className="card">
            <h2>Token Controls</h2>
            <div className="token-controls">
              {ARB_TARGET_TOKENS.map((token) => {
                const isPaused = status?.pausedTokens.includes(token);
                const isToggling = togglingTokens.has(token);
                return (
                  <div key={token} className="token-control-item">
                    <span className="token-name">{token}</span>
                    <button
                      className={`btn ${isPaused ? 'btn-success' : 'btn-danger'}`}
                      onClick={() => toggleToken(token)}
                      disabled={isToggling}
                    >
                      {isToggling ? '...' : isPaused ? 'Resume' : 'Pause'}
                    </button>
                  </div>
                );
              })}
            </div>
          </div>

          {activeCyclesList.length > 0 && (
            <div className="card">
              <h2>In-Flight Tokens</h2>
              <div style={{ marginTop: '12px' }}>
                <div className="label">Tokens in Active Cycles</div>
                <div className="value" style={{ fontSize: '1rem' }}>
                  {inFlightTokens.length > 0 ? inFlightTokens.join(', ') : 'None'}
                </div>
              </div>
              <div style={{ marginTop: '12px' }}>
                <div className="label">State Breakdown</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginTop: '4px' }}>
                  {Object.entries(stateBreakdown).map(([state, count]) => (
                    <span key={state} className="status-badge status-pending">
                      {state}: {count}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          )}

          <div className="grid">
            {balances.map((b) => (
              <div className="card" key={b.chainId}>
                <h2>{chainName(b.chainId)} Balances</h2>
                <table>
                  <tbody>
                    <tr>
                      <td>ETH (Native)</td>
                      <td className="value">{b.native}</td>
                    </tr>
                    {Object.entries(b.tokens).map(([token, amount]) => (
                      <tr key={token}>
                        <td>{token}</td>
                        <td>{amount}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
          </div>

        </>
      )}

      {tab === 'cycles' && (
        <div className="card">
          <h2>Recent Cycles</h2>
          <table>
            <thead>
              <tr>
                <th style={{ width: '30px' }}></th>
                <th>ID</th>
                <th>Token</th>
                <th>VCRED In</th>
                <th>VCRED Out</th>
                <th>State</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {cycles.map((c) => (
                <React.Fragment key={c.id}>
                  <tr
                    onClick={() => toggleExpand(c.id)}
                    style={{ cursor: 'pointer' }}
                    className="expandable-row"
                  >
                    <td style={{ textAlign: 'center' }}>
                      {loadingCycles.has(c.id) ? '...' : expandedCycles.has(c.id) ? '▼' : '▶'}
                    </td>
                    <td>{c.id}</td>
                    <td>{c.token}</td>
                    <td>{formatBigIntString(c.vcredIn, getDecimals('VCRED'))}</td>
                    <td>{c.vcredOut ? formatBigIntString(c.vcredOut, getDecimals('VCRED')) : '-'}</td>
                    <td>
                      <span className={`status-badge status-${c.state === 'COMPLETED' ? 'completed' : c.state === 'FAILED' ? 'failed' : 'pending'}`}>
                        {c.state}
                      </span>
                    </td>
                    <td>{new Date(c.updatedAt).toLocaleString()}</td>
                  </tr>
                  {expandedCycles.has(c.id) && cycleSteps.has(c.id) && (
                    <tr>
                      <td colSpan={7} className="cycle-details">
                        <table className="steps-table">
                          <thead>
                            <tr>
                              <th>Step</th>
                              <th>Chain</th>
                              <th>Status</th>
                              <th>Gas Used</th>
                              <th>Gas Price</th>
                              <th>Tx</th>
                            </tr>
                          </thead>
                          <tbody>
                            {cycleSteps.get(c.id)!.steps.map((step) => (
                              <tr key={step.id}>
                                <td>{step.stepType}</td>
                                <td>{chainName(step.chainId)}</td>
                                <td>
                                  <span className={`status-badge status-${step.status === 'confirmed' ? 'completed' : step.status === 'failed' ? 'failed' : 'pending'}`}>
                                    {step.status}
                                  </span>
                                </td>
                                <td>{formatGas(step.gasUsed)}</td>
                                <td>{formatGwei(step.gasPrice)}</td>
                                <td>
                                  {step.explorerUrl ? (
                                    <a href={step.explorerUrl} target="_blank" rel="noopener noreferrer">
                                      {step.txHash?.slice(0, 10)}...
                                    </a>
                                  ) : step.txHash ? (
                                    `${step.txHash.slice(0, 10)}...`
                                  ) : (
                                    '-'
                                  )}
                                </td>
                              </tr>
                            ))}
                            {cycleSteps.get(c.id)!.steps.length === 0 && (
                              <tr>
                                <td colSpan={6} style={{ textAlign: 'center', color: '#8b949e' }}>
                                  No steps yet
                                </td>
                              </tr>
                            )}
                          </tbody>
                        </table>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              ))}
              {cycles.length === 0 && (
                <tr>
                  <td colSpan={7} style={{ textAlign: 'center', color: '#8b949e' }}>
                    No cycles yet
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {tab === 'pnl' && pnl && (
        <>
          <div className="grid">
            <div className="card">
              <h2>Today ({pnl.today.date})</h2>
              <div style={{ marginTop: '12px' }}>
                <div className="label">Cycles Completed</div>
                <div className="value">{pnl.today.cyclesCompleted}</div>
              </div>
              <div style={{ marginTop: '12px' }}>
                <div className="label">Gross Profit</div>
                <div className={`value ${pnl.today.grossProfit.startsWith('-') ? 'negative' : 'positive'}`}>
                  {pnl.today.grossProfit} VCRED
                </div>
              </div>
              <div style={{ marginTop: '12px' }}>
                <div className="label">Net Profit</div>
                <div className={`value ${pnl.today.netProfit.startsWith('-') ? 'negative' : 'positive'}`}>
                  {pnl.today.netProfit} VCRED
                </div>
              </div>
            </div>

            <div className="card">
              <h2>Lifetime</h2>
              <div style={{ marginTop: '12px' }}>
                <div className="label">Cycles Completed / Failed</div>
                <div className="value">
                  {pnl.lifetime.cyclesCompleted} / {pnl.lifetime.cyclesFailed}
                </div>
              </div>
              <div style={{ marginTop: '12px' }}>
                <div className="label">Total VCRED Sold</div>
                <div className="value">{pnl.lifetime.totalVcredSold}</div>
              </div>
              <div style={{ marginTop: '12px' }}>
                <div className="label">Total VCRED Regained</div>
                <div className="value">{pnl.lifetime.totalVcredRegained}</div>
              </div>
              <div style={{ marginTop: '12px' }}>
                <div className="label">Gross Profit</div>
                <div className={`value ${pnl.lifetime.grossProfit.startsWith('-') ? 'negative' : 'positive'}`}>
                  {pnl.lifetime.grossProfit} VCRED
                </div>
              </div>
              <div style={{ marginTop: '12px' }}>
                <div className="label">Total Gas (Hemi / Eth)</div>
                <div>{pnl.lifetime.totalGasHemi} / {pnl.lifetime.totalGasEth} ETH</div>
              </div>
            </div>
          </div>
        </>
      )}

      {tab === 'diagnostics' && (
        <>
          <div className="card">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
              <div style={{ display: 'flex', gap: '8px' }}>
                <button
                  className={`btn ${logType === 'diag' ? 'btn-success' : ''}`}
                  onClick={() => { setLogType('diag'); setLogs([]); setExpandedLogs(new Set()); }}
                >
                  Diag Logs
                </button>
                <button
                  className={`btn ${logType === 'money' ? 'btn-success' : ''}`}
                  onClick={() => { setLogType('money'); setLogs([]); setExpandedLogs(new Set()); }}
                >
                  Money Logs
                </button>
              </div>
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                <select
                  className="btn"
                  value={levelFilter}
                  onChange={(e) => setLevelFilter(e.target.value as any)}
                  style={{ padding: '4px 8px' }}
                >
                  <option value="all">All Levels</option>
                  <option value="debug">Debug</option>
                  <option value="info">Info</option>
                  <option value="warn">Warn</option>
                  <option value="error">Error</option>
                </select>
                <input
                  type="text"
                  placeholder="Search logs..."
                  className="btn"
                  value={logFilter}
                  onChange={(e) => setLogFilter(e.target.value)}
                  style={{ padding: '4px 8px', width: '200px' }}
                />
                <button className="btn" onClick={() => {
                  if (logsPaused) setMissedLogCount(0);
                  setLogsPaused(!logsPaused);
                }}>
                  {logsPaused ? 'Resume' : 'Pause'}
                </button>
                <button className="btn" onClick={clearLogs}>Clear</button>
                <span style={{ fontSize: '0.75rem', color: '#8b949e' }}>
                  {filteredLogs.length} entries
                </span>
              </div>
            </div>
            
            <div
              className="log-container"
              ref={logContainerRef}
              onScroll={handleLogScroll}
            >
              {logsPaused && missedLogCount > 0 && (
                <div className="new-logs-badge" onClick={jumpToLatest}>
                  ↑ {missedLogCount} new log{missedLogCount > 1 ? 's' : ''} - click to view
                </div>
              )}
              {filteredLogs.length === 0 && (
                <div style={{ textAlign: 'center', color: '#8b949e', padding: '20px' }}>
                  No log entries yet
                </div>
              )}
              {filteredLogs.map((log, idx) => {
                const isExpanded = expandedLogs.has(idx);
                const summary = formatMonetarySummary(log);
                const hasData = log.data && Object.keys(log.data).length > 0;

                return (
                  <div key={`${log.ts}-${idx}`} className="log-entry-wrapper">
                    <div
                      className={`log-entry ${hasData ? 'log-entry-expandable' : ''}`}
                      onClick={() => hasData && toggleLogExpand(idx)}
                    >
                      {hasData ? (
                        <span className="log-arrow">{isExpanded ? '▼' : '▶'}</span>
                      ) : (
                        <span className="log-arrow-placeholder"></span>
                      )}
                      <span className="log-time">{new Date(log.ts).toLocaleTimeString()}</span>
                      <span className={`log-level log-level-${log.level}`}>{log.level.toUpperCase()}</span>
                      <span className="log-msg">{log.msg}</span>
                      {summary && <span className="log-summary">{summary}</span>}
                      {log.token && <span className="log-badge">{log.token}</span>}
                      {log.amount && log.token && (
                        <span className="log-badge log-amount">
                          {formatBigIntString(log.amount, getDecimals(log.token))}
                        </span>
                      )}
                      {log.chain && <span className="log-badge log-chain">{log.chain}</span>}
                      {log.explorerUrl && log.txHash && (
                        <a
                          href={log.explorerUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="log-link"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {log.txHash.slice(0, 10)}…
                        </a>
                      )}
                      {log.lzScanUrl && log.lzGuid && (
                        <a
                          href={log.lzScanUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="log-link"
                          onClick={(e) => e.stopPropagation()}
                        >
                          LZ:{log.lzGuid.slice(0, 10)}…
                        </a>
                      )}
                    </div>
                    {isExpanded && hasData && (
                      <div className="log-data-expanded">
                        {Object.entries(log.data!).map(([k, v]) => (
                          <div key={k} className="log-data-item">
                            <span className="log-data-key">{k}:</span>
                            <span className="log-data-value">{String(v)}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          <div className="card">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h2>Providers</h2>
              <button
                className="btn"
                onClick={runHealthCheck}
                disabled={healthLoading}
              >
                {healthLoading ? 'Testing...' : 'API Self Test'}
              </button>
            </div>

            {healthResult && (
              <>
                <div style={{ marginTop: '12px', marginBottom: '8px', fontSize: '0.75rem', color: '#8b949e' }}>
                  Last checked: {new Date(healthResult.timestamp).toLocaleTimeString()} |{' '}
                  <span className="positive">{healthResult.summary.ok} ok</span> |{' '}
                  <span style={{ color: '#9e6a03' }}>{healthResult.summary.degraded} degraded</span> |{' '}
                  <span className="negative">{healthResult.summary.error} error</span>
                </div>
                <div className="provider-grid">
                  {healthResult.providers.map((p) => (
                    <div key={p.provider} className={`provider-card provider-${p.status}`}>
                      <span className="provider-name">{p.provider}</span>
                      <span className={`provider-badge provider-badge-${p.status}`}>{p.status}</span>
                      <span className="provider-latency">{p.latencyMs}ms</span>
                      {p.error && <div className="provider-error">{p.error}</div>}
                    </div>
                  ))}
                </div>
              </>
            )}

            {!healthResult && (
              <p style={{ marginTop: '12px', color: '#8b949e', fontSize: '0.85rem' }}>
                Click "API Self Test" to check provider connectivity
              </p>
            )}
          </div>
        </>
      )}

      <div style={{ marginTop: '20px', color: '#8b949e', fontSize: '0.75rem' }}>
        Auto-refresh: 60s | <button className="btn" onClick={refresh} style={{ fontSize: '0.75rem', padding: '2px 8px' }}>Refresh Now</button>
      </div>
    </div>
  );
}

export default App;
