# keeper-arb

Cross-chain VCRED arbitrage keeper. Buys underpriced assets on Hemi, bridges to Ethereum, converts to USDC, bridges back, closes to VCRED.

## Arb Loop

```
VCRED → X (Hemi) → bridge → X (Eth) → USDC (Eth) → bridge → USDC (Hemi) → VCRED
```

Target tokens: WETH, WBTC, hemiBTC, cbBTC, XAUt, VUSD

## Quick Start (Docker)

```bash
# Create secrets
mkdir -p secrets
echo "0xYOUR_PRIVATE_KEY" > secrets/karb_pkey.txt
echo "your-dashboard-password" > secrets/karb_dashpass.txt
chmod 600 secrets/*.txt

# Run
docker compose up --build
```

Dashboard at http://localhost:7120

## Configuration

### Docker Secrets (required)

| Secret | File | Description |
|--------|------|-------------|
| `ARBITRAGE_PRIVATE_KEY` | `secrets/karb_pkey.txt` | Wallet private key |
| `DASHBOARD_PASSWORD` | `secrets/karb_dashpass.txt` | Dashboard basic auth |

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `HEMI_RPC_URL` | no | Hemi RPC (has default) |
| `ETH_RPC_URL` | no | Ethereum RPC (has default) |
| `WEBHOOK_URL` | no | Slack/Discord notifications |

## Commands

| Command | Description |
|---------|-------------|
| `npm run keeper` | Keeper + dashboard |
| `npm run dashboard` | Dashboard only |
| `npm run dev` | Dev mode (tsx watch) |
| `npm test` | Run tests |
| `npm run lint` | Lint |

## Architecture

**Reconciliation model**: Ansible-like steady-state loop. Reads DB + chain state, executes next action, repeats. All steps idempotent.

**Persistence**: SQLite. Survives restarts mid-bridge.

**Single instance**: Lock prevents concurrent execution.

### Cycle States

```
DETECTED → HEMI_SWAP_DONE → BRIDGE_OUT_SENT → [prove/finalize] → ON_ETHEREUM
→ ETH_SWAP_DONE → USDC_BRIDGE_BACK_SENT → ON_HEMI_USDC → HEMI_CLOSE_SWAP_DONE → COMPLETED
```

### Providers

| Chain | Swap Priority | Bridge |
|-------|--------------|--------|
| Hemi | 1delta → SushiSwap | Stargate (WETH, hemiBTC) or Hemi tunnel |
| Ethereum | CowSwap → Matcha → SushiSwap | Stargate (USDC back) |

### Sizing

Binary search finds max profitable VCRED input (min 100). End-to-end profit estimate includes gas + bridge fees.

## Logging

- `logs/diag.log` - diagnostic (JSONL)
- `logs/money.log` - swaps, bridges, P&L only (JSONL)

## Dashboard

Password-protected web UI. Shows balances, active cycles, history, P&L.

## Container

Use Docker Compose (recommended):

```bash
docker compose up --build
```

Or build and run manually:

```bash
docker build -t keeper-arb .
docker run \
  -v ./data:/app/data \
  -v ./logs:/app/logs \
  -v ./secrets/karb_pkey.txt:/run/secrets/ARBITRAGE_PRIVATE_KEY:ro \
  -v ./secrets/karb_dashpass.txt:/run/secrets/DASHBOARD_PASSWORD:ro \
  -p 7120:7120 \
  keeper-arb
```

Runs non-root. Secrets must be mounted to `/run/secrets/`.

## Chains

- Hemi: 43111
- Ethereum: 1
