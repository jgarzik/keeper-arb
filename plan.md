# keeper-arb Implementation Plan

Cross-chain VCRED arbitrage keeper: Hemi (L2) <-> Ethereum (L1)

## Arb Loop
1. Hemi: VCRED -> X (underpriced token)
2. Bridge: X Hemi -> Ethereum (Stargate or Hemi tunnel)
3. Ethereum: X -> USDC
4. Bridge: USDC Ethereum -> Hemi (Stargate)
5. Hemi: USDC -> VCRED (close loop)

## Implementation Phases

### Phase 1: Scaffolding [DONE]
- npm/TypeScript/ESLint/Vitest setup
- config.ts, chains.ts, tokens.ts
- db.ts (SQLite), logging.ts (JSONL)

### Phase 2: Wallet [DONE]
- viem wallet client
- public clients (Hemi, Ethereum)
- nonce manager, balance utils

### Phase 3: Swap Providers [DONE]
- SushiSwap V2 (Ethereum): Router 0xd9e1cE17...
- SushiSwap V3 (Hemi): Router 0x33d91116..., Quoter 0x1400feFD...
- Uniswap V3 quoter (reference pricing)

### Phase 4: Bridge Providers [DONE]
- Stargate/LayerZero: Hemi 0x2F6F07CD..., LZ Endpoint 30329
- Hemi tunnel OP-stack (other tokens)
  - initiate -> prove -> finalize flow

### Phase 5: Core Engine [DONE]
- planner.ts: opportunity detection
- sizing.ts: binary search for optimal trade size
- profit.ts: end-to-end profit estimation
- reconciler.ts: Ansible-like state loop
- steps.ts: idempotent executors
- accounting.ts: P&L tracking

### Phase 6: State Machine [DONE]
States: DETECTED -> HEMI_SWAP_DONE -> BRIDGE_OUT_* -> ON_ETHEREUM -> ETH_SWAP_DONE -> USDC_BRIDGE_BACK_SENT -> ON_HEMI_USDC -> CLOSE_SWAP_DONE -> COMPLETED|FAILED

### Phase 7: Main Loop [DONE]
- index.ts entry point
- single-instance lock
- reconciler interval
- dashboard server

### Phase 8: Dashboard [DONE]
- React + Vite
- Status, Cycles, P&L views
- Pause/resume controls
- Basic auth

### Phase 9: Polish [DONE]
- notifications.ts (webhooks)
- Dockerfile, docker-compose.yml
- Unit tests (45 tests, all pass)

## Future Work
- Add 1delta aggregator (Hemi primary swap)
- Add CowSwap/Matcha (Ethereum aggregators)
- API key support
- Hemi tunnel prove/finalize automation

## Key Files
```
src/
├── config.ts, chains.ts, tokens.ts
├── db.ts, logging.ts, wallet.ts
├── server.ts, notifications.ts, index.ts
├── engine/
│   ├── planner.ts, sizing.ts, profit.ts
│   ├── reconciler.ts, steps.ts, accounting.ts
└── providers/
    ├── swapInterface.ts, sushiSwap.ts, uniswapRef.ts
    ├── bridgeInterface.ts, stargateBridge.ts, hemiTunnel.ts
dashboard/
├── src/App.tsx, main.tsx, index.css
```

## Running
```bash
# Development
npm install
npm run build
npm run dev

# Dashboard
cd dashboard && npm install && npm run build

# Production
docker-compose up -d
```
