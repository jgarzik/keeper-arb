# VCRED Daily Cross‑Chain Arb Keeper — Plan & Design Spec (v2)

## 1) What we’re building
A Node.js/TypeScript “keeper bot” that **continuously and safely** executes your daily, one-direction arbitrage loop:

1. **Hemi:** swap **VCRED → X** (X ∈ {ETH, WBTC, hemiBTC, cbBTC, XAUt, VUSD}) when X is underpriced on Hemi.
2. **Bridge out:** move X **Hemi → Ethereum** using a per-token route.
3. **Ethereum:** swap **X → USDC**.
4. **Bridge back:** move **USDC Ethereum → Hemi** (fast route).
5. **Hemi:** swap **USDC → VCRED** to close the loop.

Core principle: **Ansible-like “steady-state reconciliation.”** The keeper assumes what “steady state” should look like, then continually reconciles reality to that steady state, step-by-step, with idempotency and durable state.

## 2) Non-goals
- No “both-direction” arbitrage (only buy-underpriced-on-Hemi direction).
- No custodial custody or MPC (single hot wallet).
- No complicated infra requirements (works on a VPS or in k8s container).

## 3) Key constraints / requirements (from you)
- **Languages/tools:** TypeScript + Node.js, viem; Vite for dashboard.
- **Hemi swap priority:** 1delta aggregator → fallback SushiSwap.
- **Ethereum swap priority:** CowSwap → Matcha → fallback SushiSwap.
- **Bridge routes:** configurable; **ETH & hemiBTC via Stargate/LayerZero**, everything else via **Hemi native “ETH tunnel”**.
- **Sizing algorithm:** dynamic sizing.
  - Start at 1000 VCRED input.
  - Binary search to maximize profitable VCRED sale (min swap 100 VCRED).
  - Profit threshold is **any profit > 0** (but we’ll implement conservative fee accounting and allow a config floor).
- **Security:** hot wallet loads key material on startup only; **never write secrets to logs/files**.
- **Ops:** runs as non-root on Ubuntu VPS; also runs in container; env-var secrets (optionally injected by 1Password + k8s).
- **Logging:** two logs (diagnostic + money-moves).
- **Dashboard:** browser view, password-auth, focuses on P&L (incl. gas/fees).
- **Testing:** unit tests only; no real-money tests.
- **Notifications:** webhooks (Slack/Discord/etc).

## 4) Architecture overview

### 4.1 Processes
Single Node process with two internal servers:
- **Keeper loop:** state reconciliation + execution
- **Dashboard server:** serves UI + reads state/logs

Why single process?
- Fewer moving pieces.
- Single lock to prevent double execution.

### 4.2 Persistence
We must survive restarts mid-bridge.
- Use **SQLite** (single file) via a small TS ORM or raw SQL.
- Store:
  - “Tasks” (arb cycles) and their current step/state
  - Chain tx hashes + receipts
  - Bridge message identifiers (if available)
  - Accounting ledger entries

### 4.3 Modules (few files, but clear separation)
Suggested minimal file layout:

- `src/config.ts` (env parsing, constants)
- `src/tokens.ts` (token constants + metadata)
- `src/chains.ts` (RPCs, chain IDs)
- `src/providers/` (very small)
  - `swapProviders.ts` (HemiSwapProvider, EthSwapProvider)
  - `bridgeProviders.ts` (StargateBridge, HemiTunnelBridge)
  - `priceProviders.ts` (UniswapRefPrice)
- `src/engine/` (core)
  - `planner.ts` (opportunity detection + sizing)
  - `reconciler.ts` (Ansible-like state loop)
  - `steps.ts` (idempotent step executors)
  - `accounting.ts` (P&L + fee tracking)
- `src/db.ts` (sqlite)
- `src/logging.ts` (2 loggers)
- `src/server.ts` (dashboard + auth)
- `src/index.ts` (main)

## 5) Chains & RPC
- **Hemi Mainnet:** ChainID **43111**, gas token ETH.
- **Ethereum Mainnet:** ChainID **1**.

Both chains have configurable RPC URLs:
- `HEMI_RPC_URL`
- `ETH_RPC_URL`

## 6) Token constants & metadata
We want named constants for token addresses.

### 6.1 Ethereum (standard)
- `ETH` is native.
- `USDC`, `WBTC`, `WETH`, `cbBTC`, `XAUt` are ERC-20.

### 6.2 Hemi
- `VCRED` (ERC-20)
- `hemiBTC` (ERC-20)
- `VUSD` (ERC-20)
- plus bridged ERC-20s for WBTC/cbBTC/XAUt (to be filled if/when their on-explorer metadata is accessible).

> Implementation note: Keep `tokens.ts` as the single source of truth. Everything references `TokenId` enums, never raw addresses.

Each token entry includes:
- `symbol`, `decimals`, `chainToAddress: { [chainId]: Address | null }`
- `bridgeRouteOut` (Hemi→Eth)
- `minSwapVcred`, `maxSwapVcredSoftCap`

## 7) The arb decision model

### 7.1 Reference pricing (your current method)
- **Ethereum reference:** Uniswap quote in USDC terms.
  - Example: compare `quote(1000 VCRED → WBTC on Hemi)` to `quote(1000 USDC → WBTC on Ethereum Uniswap)`.

### 7.2 System profit model (recommended)
We’ll compute a **conservative end-to-end profit estimate** in VCRED units:

Given a candidate size `vcredIn`:
1. Quote Hemi swap: `vcredIn → xOut`.
2. Quote Ethereum swap: `xOut → usdcOut`.
3. Quote Hemi closing swap: `usdcOut → vcredOut`.
4. Estimate fees (gas + bridge fees + swap fees). Convert to VCRED using latest `USDC→VCRED` quote.
5. Profit = `vcredOut - vcredIn - feeVcred`.

We still use Uniswap ref price for “oppy detection,” but the **final gating** uses the end-to-end estimate so we don’t systematically bleed on bridging/gas.

Config:
- `MIN_PROFIT_VCRED` default `0`, but strongly recommend a small positive floor.

## 8) Dynamic sizing algorithm (binary search)

### 8.1 Goal
For each token X, find the **maximum** `vcredIn` (>=100) such that `profit(vcredIn) > 0`.

### 8.2 Method
1. Start with `candidate = 1000`.
2. Ensure bounds:
   - lower = 100
   - upper = min(availableVCRED, configuredCap)
3. Probe to find a bracket where profit switches:
   - if profit(1000) <= 0: shrink by halves toward 100.
   - if profit(1000) > 0: grow upper by doubling until profit <= 0 or you hit cap.
4. Binary search on `[good, bad]` interval to find max profitable size.
5. Stop when interval < 1 VCRED (or configured granularity).

Guardrails:
- Max quote calls per token per loop.
- Cache quotes for a short TTL to reduce RPC/API load.

## 9) State machine / reconciliation

### 9.1 Entities
- **Cycle (arb task):** one attempt to convert VCRED→X→USDC→VCRED.
- **Step:** atomic action with deterministic identity.

### 9.2 Canonical states
Each cycle is in exactly one state:

- `DETECTED` (oppy identified; sizing found)
- `HEMI_SWAP_DONE` (VCRED→X executed)
- `BRIDGE_OUT_SENT` (X sent from Hemi toward Ethereum)
- `BRIDGE_OUT_PROVE_REQUIRED` (only for Hemi tunnel route)
- `BRIDGE_OUT_PROVED`
- `BRIDGE_OUT_FINALIZE_REQUIRED` (only for Hemi tunnel route)
- `ON_ETHEREUM` (X balance detected on Ethereum)
- `ETH_SWAP_DONE` (X→USDC executed)
- `USDC_BRIDGE_BACK_SENT`
- `ON_HEMI_USDC` (USDC balance detected on Hemi)
- `HEMI_CLOSE_SWAP_DONE` (USDC→VCRED executed)
- `COMPLETED`
- `FAILED` (manual intervention required)

### 9.3 Reconciler loop
Every N seconds:
1. Read DB tasks and wallet balances.
2. For each task, determine “next required action” based on:
   - stored state + tx receipts + balance checks + bridge events
3. Execute at most K actions per loop (rate limiting).

Idempotency:
- Every step is safe to retry.
- Steps check if already done (by tx receipt OR by balance delta) before sending another tx.

## 10) Bridges

### 10.1 Bridge routing (configurable)
Per token on Hemi:
- `bridgeOut`: `STARGATE_LZ` or `HEMI_TUNNEL`

Always for return leg:
- `bridgeBackUsdc`: `STARGATE_LZ`

### 10.2 Stargate/LayerZero route (fast)
Abstraction:
- `send(amount, token, fromChain, toChain, toAddress)`
- `track(messageId|txHash) → status`
- `detectArrival(token, chain, address, minAmount)`

Implementation approach:
- Use onchain tx receipt + balance detection as primary.
- If Stargate provides message ids, record them and poll destination event logs.

### 10.3 Hemi native “ETH tunnel” route (slow, 2-step)
Assume OP-like withdrawal model:
- Step A: initiate withdrawal on Hemi.
- Step B: “prove” becomes available later.
- Step C: “finalize” becomes available ~24h later (per your experience).

Design:
- Store L2 withdrawal tx hash.
- Derive withdrawal payload from L2 logs.
- Poll readiness:
  - `proveReady` and `finalizeReady`
- Execute prove/finalize txs on Ethereum when ready.

Fallback if derivation is hard:
- Allow manual “bridge proof tx data” import via dashboard to unblock.

## 11) Swap providers

### 11.1 Hemi swap
Primary: **1delta aggregator**
- Quote + execution via their preferred method (API or contract).

Fallback: **SushiSwap**
- Router execution.

### 11.2 Ethereum swap
Primary: **CowSwap**
- Quote via CowSwap API; execute by signing an order.

Secondary: **Matcha (0x)**
- Quote via 0x API; execute onchain via provided calldata.

Fallback: **SushiSwap**
- Onchain router.

Implementation strategy:
- Define a common interface:
  - `quoteExactIn(tokenIn, tokenOut, amountIn) -> { amountOut, calldata?, to?, value?, gasEstimate? }`
  - `execute(quote) -> txHash`

Phase recommendation:
- Phase 1: implement SushiSwap on both chains + plug in Uniswap ref pricing.
- Phase 2: add 1delta + CowSwap + Matcha.

## 12) Safety / money-loss prevention

### 12.1 Hard guards
- Never trade below `MIN_SWAP_VCRED`.
- Never exceed `MAX_SWAP_VCRED_SOFT_CAP` (config), even if profitable.
- Always set slippage limits.
- Always validate token allowances/approvals.
- Per-chain nonce manager to avoid stuck txs.

### 12.2 Failure handling
- Any step can fail; failures are recorded in DB with full context.
- Automatic retry policy:
  - retry transient RPC errors
  - retry underpriced tx with replacement (EIP-1559 bump)
  - do NOT “retry swaps” blindly if state uncertain

### 12.3 Human-in-the-loop escape hatches
- Dashboard “pause all execution.”
- Dashboard “pause token X.”
- Manual override to mark step as completed / skipped.

## 13) Accounting & P&L
We maintain an internal ledger:
- Every tx creates an entry:
  - chain, txHash, gasUsed, effectiveGasPrice, feeNative
- Every swap creates entries:
  - amountIn, amountOut, tokenIn, tokenOut
- Every bridge creates entries:
  - amount, token, fromChain, toChain

P&L:
- Compute realized profit per cycle in VCRED and USDC terms.
- Daily aggregation:
  - total VCRED sold
  - total VCRED regained
  - net profit
  - total gas + bridge fees

## 14) Logging

### 14.1 Diagnostic log (console + file)
- `logs/diag.log` (JSONL preferred)
- Levels: debug/info/warn/error

### 14.2 Money-moves log (append-only)
- `logs/money.log` (JSONL)
- Only:
  - swaps
  - bridges
  - prove/finalize txs
  - balance deltas
  - cycle completion + P&L

## 15) Dashboard

### 15.1 UX
- “Current State” panel:
  - per token: last oppy, next action, in-flight cycles
  - balances by chain
- “History” table:
  - cycles with step timeline
  - tx hashes with explorer links
- “P&L” page:
  - daily and lifetime totals

### 15.2 Auth
- Simple password auth:
  - `DASHBOARD_PASSWORD`
- Implementation:
  - Basic Auth header, or cookie session.

### 15.3 Tech
- Vite + minimal UI (React optional).
- Server reads from SQLite + log tail.

## 16) Notifications (webhooks)
Config:
- `WEBHOOK_URL`

Events:
- oppy detected + chosen size
- each onchain tx submitted + confirmed
- bridge stage ready (prove/finalize)
- cycle completed + P&L
- stuck condition (timeout thresholds)

## 17) Secrets handling
- Input via env vars at startup:
  - `ARBITRAGE_MNEMONIC` or `ARBITRAGE_PRIVATE_KEY`
- Never print.
- Process memory only.
- For k8s:
  - 1Password injects env vars.

## 18) DevOps & running

### 18.1 NPM scripts
- `npm run keeper` (starts keeper + dashboard)
- `npm run dashboard` (dashboard only)
- `npm test`
- `npm run lint`

### 18.2 Container
- `Dockerfile` builds app.
- Runs as non-root user.
- Mount a volume for `./data` and `./logs`.

### 18.3 Single-instance lock
- Acquire advisory lock (sqlite lock row or lockfile).
- If lock exists, refuse to start.

## 19) Testing plan (unit tests)
- Sizing algorithm: monotonic assumptions, bracket finding, binary search correctness.
- Profit calculation: fee conversion, quote plumbing.
- Reconciler: state transition correctness on mocked receipts/balances.
- Accounting: ledger entries + P&L rollups.

Mock strategy:
- Replace providers with deterministic in-memory mocks.

## 20) Clarifications still needed (for implementation)
1. VCRED’s expected $ peg/volatility: do we treat 1 VCRED ≈ 1 USDC for reporting, or always compute via onchain USDC↔VCRED quote?
2. For Hemi “ETH tunnel,” which exact bridge contracts are used (addresses + ABI), or can we rely on OP-standard contracts predeploys?
3. CowSwap/Matcha usage: are API keys available (optional), or should we default to SushiSwap on Ethereum for v1?

---

## Appendix A — Token constants we already have
Fill the rest in `tokens.ts` as you confirm them.

### Hemi
- VCRED: `0x390D9C7c5b48dB6d15D76b96D1D8a9bfD94d93B0`
- hemiBTC: `0xAA40BD69c252A882522A588b8661a8b9178B9aE3`
- VUSD: `0x7a06C4F49e50D518dfAC7665A8d811B2EaA6353B`

### Ethereum
- cbBTC: `0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf`

(USDC/WBTC/WETH/XAUt addresses are standard and should be pulled from canonical sources during implementation.)

