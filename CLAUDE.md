# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Run Commands

```bash
npm run build       # TypeScript compile to dist/
npm run keeper      # Run keeper bot (includes dashboard)
npm run dashboard   # Dashboard server only
npm run dev         # Dev mode with tsx watch
npm run lint        # ESLint
npm run lint:fix    # ESLint with auto-fix
npm test            # Vitest run all tests
npm run test:watch  # Vitest watch mode
```

Single test file: `npx vitest run src/engine/sizing.test.ts`

## Architecture

Cross-chain VCRED arbitrage keeper for Hemi/Ethereum. Executes a one-direction arb loop:
1. Hemi: VCRED → X (where X is underpriced)
2. Bridge X from Hemi → Ethereum
3. Ethereum: X → USDC
4. Bridge USDC back to Hemi
5. Hemi: USDC → VCRED

### Core Design: Ansible-like Reconciliation

The keeper uses a **steady-state reconciliation** model. A continuous loop reads current state (DB + on-chain balances) and executes the next required action for each cycle. All steps are idempotent and safe to retry.

### Cycle States

`DETECTED` → `HEMI_SWAP_DONE` → `BRIDGE_OUT_SENT` → [optional prove/finalize for Hemi tunnel] → `ON_ETHEREUM` → `ETH_SWAP_DONE` → `USDC_BRIDGE_BACK_SENT` → `ON_HEMI_USDC` → `HEMI_CLOSE_SWAP_DONE` → `COMPLETED`

### Key Modules

- **src/engine/reconciler.ts**: Main state machine loop. Processes active cycles and finds new opportunities.
- **src/engine/planner.ts**: Opportunity detection using reference pricing.
- **src/engine/sizing.ts**: Binary search to find max profitable VCRED size.
- **src/engine/steps.ts**: Idempotent step executors for swaps/bridges.
- **src/engine/accounting.ts**: P&L tracking and ledger entries.
- **src/providers/**: Swap and bridge provider interfaces + implementations (SushiSwap, Stargate, Hemi tunnel).
- **src/db.ts**: SQLite persistence for cycles, steps, ledger. Single-instance lock.
- **src/tokens.ts**: Token registry. All token lookups use `TokenId` enum, never raw addresses.

### Provider Priority

- Hemi swaps: 1delta → SushiSwap fallback
- Ethereum swaps: CowSwap → Matcha → SushiSwap fallback
- Bridges: Stargate/LayerZero (fast) or Hemi tunnel (slow, 2-step prove/finalize)

### Chains

- Hemi Mainnet: ChainID 43111
- Ethereum Mainnet: ChainID 1

## Environment Variables

Required:
- `ARBITRAGE_PRIVATE_KEY` or `ARBITRAGE_MNEMONIC` - wallet key (never logged)
- `HEMI_RPC_URL`, `ETH_RPC_URL` - RPC endpoints
- `DASHBOARD_PASSWORD` - basic auth for dashboard

See `src/config.ts` for full list.

## Testing

Unit tests only (no real-money tests). Tests use deterministic mocks for providers.
Tests are co-located: `*.test.ts` next to source files.
