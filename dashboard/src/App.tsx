import React, { useState, useEffect } from 'react';

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
  data?: Record<string, unknown>;
}

type Tab = 'status' | 'cycles' | 'pnl' | 'logs';
type LogType = 'diag' | 'money';

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
    const interval = setInterval(refresh, 10000);
    return () => clearInterval(interval);
  }, []);

  // SSE log streaming
  useEffect(() => {
    let eventSource: EventSource | null = null;
    let reconnectTimeout: NodeJS.Timeout | null = null;
    let reconnectAttempts = 0;

    const connect = () => {
      eventSource = new EventSource(`/api/logs/stream?type=${logType}`);

      eventSource.onmessage = (event) => {
        if (logsPaused) return;
        
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
        <button className={`tab ${tab === 'logs' ? 'active' : ''}`} onClick={() => setTab('logs')}>
          Logs
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
                    <td>{c.vcredIn}</td>
                    <td>{c.vcredOut ?? '-'}</td>
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
                <div className={`value ${parseFloat(pnl.today.grossProfit) >= 0 ? 'positive' : 'negative'}`}>
                  {pnl.today.grossProfit} VCRED
                </div>
              </div>
              <div style={{ marginTop: '12px' }}>
                <div className="label">Net Profit</div>
                <div className={`value ${parseFloat(pnl.today.netProfit) >= 0 ? 'positive' : 'negative'}`}>
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
                <div className={`value ${parseFloat(pnl.lifetime.grossProfit) >= 0 ? 'positive' : 'negative'}`}>
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

      {tab === 'logs' && (
        <>
          <div className="card">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
              <div style={{ display: 'flex', gap: '8px' }}>
                <button
                  className={`btn ${logType === 'diag' ? 'btn-success' : ''}`}
                  onClick={() => { setLogType('diag'); setLogs([]); }}
                >
                  Diag Logs
                </button>
                <button
                  className={`btn ${logType === 'money' ? 'btn-success' : ''}`}
                  onClick={() => { setLogType('money'); setLogs([]); }}
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
                <button className="btn" onClick={() => setLogsPaused(!logsPaused)}>
                  {logsPaused ? 'Resume' : 'Pause'}
                </button>
                <button className="btn" onClick={clearLogs}>Clear</button>
                <span style={{ fontSize: '0.75rem', color: '#8b949e' }}>
                  {filteredLogs.length} entries
                </span>
              </div>
            </div>
            
            <div className="log-container">
              {filteredLogs.length === 0 && (
                <div style={{ textAlign: 'center', color: '#8b949e', padding: '20px' }}>
                  No log entries yet
                </div>
              )}
              {filteredLogs.map((log, idx) => (
                <div key={`${log.ts}-${idx}`} className="log-entry">
                  <span className="log-time">{new Date(log.ts).toLocaleTimeString()}</span>
                  <span className={`log-level log-level-${log.level}`}>{log.level.toUpperCase()}</span>
                  <span className="log-msg">{log.msg}</span>
                  {log.token && <span className="log-badge">token={log.token}</span>}
                  {log.chain && <span className="log-badge">chain={log.chain}</span>}
                  {log.amount && <span className="log-badge">amount={log.amount}</span>}
                  {log.explorerUrl && log.txHash && (
                    <a href={log.explorerUrl} target="_blank" rel="noopener noreferrer" className="log-link">
                      tx={log.txHash.slice(0, 10)}...
                    </a>
                  )}
                  {log.data && Object.keys(log.data).length > 0 && (
                    <span className="log-data">
                      {Object.entries(log.data).map(([k, v]) => `${k}=${String(v)}`).join(' ')}
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>
        </>
      )}

      <div style={{ marginTop: '20px', color: '#8b949e', fontSize: '0.75rem' }}>
        Auto-refresh: 10s | <button className="btn" onClick={refresh} style={{ fontSize: '0.75rem', padding: '2px 8px' }}>Refresh Now</button>
      </div>
    </div>
  );
}

export default App;
