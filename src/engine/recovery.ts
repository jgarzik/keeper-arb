import { type Clients, getTokenBalance } from '../wallet.js';
import { CHAIN_ID_ETHEREUM } from '../chains.js';
import { getToken, validateTokenId } from '../tokens.js';
import { getCyclesByState, updateCycleState } from '../db.js';
import { diag } from '../logging.js';

/**
 * Recover stuck cycles on startup.
 *
 * Scans for FAILED cycles that still have token balance on Ethereum.
 * These are cycles where ETH_SWAP failed (e.g. SushiSwap revert)
 * but the tokens are still in the wallet. Reset them to ON_ETHEREUM
 * so the reconciler can retry (now with CowSwap).
 */
export async function recoverStuckCycles(clients: Clients): Promise<number> {
  const failedCycles = getCyclesByState('FAILED');
  let recovered = 0;

  for (const cycle of failedCycles) {
    try {
      const token = validateTokenId(cycle.token);
      const tokenMeta = getToken(token);
      const tokenEth = tokenMeta.chains[CHAIN_ID_ETHEREUM]?.address;

      if (!tokenEth) continue;

      const balance = await getTokenBalance(clients, CHAIN_ID_ETHEREUM, tokenEth);
      if (balance === 0n) continue;

      // This cycle has token balance on Ethereum - reset to ON_ETHEREUM
      diag.info('Recovering stuck cycle', {
        cycleId: cycle.id,
        token,
        balance: balance.toString(),
        previousError: cycle.error,
      });

      updateCycleState(cycle.id, 'ON_ETHEREUM');
      recovered++;
    } catch (err) {
      diag.warn('Failed to check cycle for recovery', {
        cycleId: cycle.id,
        error: String(err),
      });
    }
  }

  if (recovered > 0) {
    diag.info('Stuck cycle recovery complete', { recovered, total: failedCycles.length });
  }

  return recovered;
}
