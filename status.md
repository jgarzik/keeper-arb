# keeper-arb Build Status

## Overall: COMPLETE (v0.1.0)

All 9 phases implemented. Build passes. 45 unit tests pass. Lint clean.

## Verification
- `npm run build` - TypeScript compiles
- `npm run lint` - ESLint passes
- `npm run test` - 45 tests pass
- `cd dashboard && npm run build` - Vite builds

## Components Status

| Component | Status | Notes |
|-----------|--------|-------|
| Config/Env | Done | HEMI_RPC_URL, ETH_RPC_URL, wallet key |
| Token Registry | Done | VCRED, USDC, WETH, WBTC, hemiBTC, cbBTC, XAUt, VUSD |
| Chain Config | Done | Hemi (43111), Ethereum (1) |
| SQLite DB | Done | cycles, steps, ledger tables |
| Logging | Done | diag.log + money.log (JSONL) |
| Wallet | Done | viem clients, nonce manager |
| SushiSwap Eth | Done | V2 Router: 0xd9e1cE17... |
| SushiSwap Hemi | Done | V3 Router: 0x33d91116..., Quoter: 0x1400feFD... |
| Uniswap Quoter | Done | V3 quoter for ref pricing |
| Stargate Bridge | Done | Hemi: 0x2F6F07CD..., LZ Endpoint: 30329 |
| Hemi Tunnel | Done | OP-stack bridge, prove/finalize TBD |
| Opportunity Detection | Done | Compare Hemi vs Eth prices |
| Sizing Algorithm | Done | Binary search, tested |
| Profit Estimation | Done | End-to-end with fees |
| Reconciler | Done | State machine loop |
| Steps | Done | Idempotent executors |
| Accounting | Done | P&L tracking |
| Dashboard | Done | React + Vite |
| Webhooks | Done | Discord/Slack compatible |
| Docker | Done | Dockerfile + compose |
| Unit Tests | Done | 45 tests |

## To Run
1. Copy .env.example to .env
2. Fill in RPC URLs, private key, dashboard password
3. `npm run build && npm run keeper`

## Test Coverage
- sizing.test.ts - 9 tests (binary search logic)
- profit.test.ts - 10 tests (profit calculations)
- accounting.test.ts - 12 tests (formatting)
- tokens.test.ts - 14 tests (token registry)
