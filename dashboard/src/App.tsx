import { useState, useEffect } from 'react';

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

type Tab = 'status' | 'cycles' | 'pnl';

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

  const togglePause = async () => {
    if (status?.paused) {
      await api('/resume', 'POST');
    } else {
      await api('/pause', 'POST');
    }
    refresh();
  };

  const chainName = (id: number) => (id === 43111 ? 'Hemi' : id === 1 ? 'Ethereum' : `Chain ${id}`);

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
                <tr key={c.id}>
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
              ))}
              {cycles.length === 0 && (
                <tr>
                  <td colSpan={6} style={{ textAlign: 'center', color: '#8b949e' }}>
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

      <div style={{ marginTop: '20px', color: '#8b949e', fontSize: '0.75rem' }}>
        Auto-refresh: 10s | <button className="btn" onClick={refresh} style={{ fontSize: '0.75rem', padding: '2px 8px' }}>Refresh Now</button>
      </div>
    </div>
  );
}

export default App;
