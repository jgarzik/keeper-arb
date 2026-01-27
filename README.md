# keeper-arb

Cross-chain VCRED arbitrage keeper. Buys underpriced assets on Hemi, bridges to Ethereum, converts to USDC, bridges back, closes to VCRED.

## Arb Loop

```
VCRED → X (Hemi) → bridge → X (Eth) → USDC (Eth) → bridge → USDC (Hemi) → VCRED
```

Target tokens: WETH, WBTC, hemiBTC, cbBTC, XAUt, VUSD

## Quick Start

```bash
cp .env.example .env  # configure
npm install
npm run build
npm run keeper        # runs keeper + dashboard
```

## Environment

| Variable | Required | Description |
|----------|----------|-------------|
| `ARBITRAGE_PRIVATE_KEY` | yes* | Wallet key |
| `ARBITRAGE_MNEMONIC` | yes* | Alternative to private key |
| `HEMI_RPC_URL` | yes | Hemi RPC endpoint |
| `ETH_RPC_URL` | yes | Ethereum RPC endpoint |
| `DASHBOARD_PASSWORD` | yes | Dashboard basic auth |
| `WEBHOOK_URL` | no | Slack/Discord notifications |
| `MIN_PROFIT_VCRED` | no | Profit floor (default: 0) |

*One of private key or mnemonic required.

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

```bash
docker build -t keeper-arb .
docker run -v ./data:/app/data -v ./logs:/app/logs --env-file .env keeper-arb
```

Runs non-root. Mount `data/` and `logs/`.

For Docker Compose, keep secrets under the repo root in `secrets/` (ignored by git) to match `docker-compose.yml`.

## Chains

- Hemi: 43111
- Ethereum: 1
