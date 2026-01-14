import { type Address, encodeFunctionData, parseAbi } from 'viem';
import { type Clients, getPublicClient, getWalletClient, getNextNonce } from '../wallet.js';
import { type SwapProvider, type SwapQuote } from './swapInterface.js';
import { CHAIN_ID_HEMI, CHAIN_ID_ETHEREUM } from '../chains.js';
import { diag } from '../logging.js';

// SushiSwap V2 Router ABI (subset)
const SUSHI_ROUTER_ABI = parseAbi([
  'function getAmountsOut(uint amountIn, address[] path) view returns (uint[] amounts)',
  'function swapExactTokensForTokens(uint amountIn, uint amountOutMin, address[] path, address to, uint deadline) returns (uint[] amounts)',
  'function swapExactETHForTokens(uint amountOutMin, address[] path, address to, uint deadline) payable returns (uint[] amounts)',
  'function swapExactTokensForETH(uint amountIn, uint amountOutMin, address[] path, address to, uint deadline) returns (uint[] amounts)',
]);

// Known router addresses
const SUSHI_ROUTERS: Record<number, Address> = {
  [CHAIN_ID_ETHEREUM]: '0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F',
  // Hemi uses SushiSwap V3 - will need RouteProcessor address
  // Placeholder - needs to be discovered from Hemi explorer
  [CHAIN_ID_HEMI]: '0x0000000000000000000000000000000000000000',
};

// WETH addresses for native ETH swaps
const WETH: Record<number, Address> = {
  [CHAIN_ID_ETHEREUM]: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
  [CHAIN_ID_HEMI]: '0x4200000000000000000000000000000000000006',
};

function createSushiSwapProvider(chainId: number): SwapProvider {
  const routerAddress = SUSHI_ROUTERS[chainId];
  const weth = WETH[chainId];

  return {
    name: `SushiSwap-${chainId}`,
    chainId,

    async quoteExactIn(
      clients: Clients,
      tokenIn: Address,
      tokenOut: Address,
      amountIn: bigint
    ): Promise<SwapQuote | null> {
      if (routerAddress === '0x0000000000000000000000000000000000000000') {
        diag.warn('SushiSwap router not configured for chain', { chainId });
        return null;
      }

      const publicClient = getPublicClient(clients, chainId);
      const path: Address[] = [tokenIn, tokenOut];

      // If direct pair doesn't exist, try routing through WETH
      try {
        const amounts = await publicClient.readContract({
          address: routerAddress,
          abi: SUSHI_ROUTER_ABI,
          functionName: 'getAmountsOut',
          args: [amountIn, path],
        });

        const amountOut = amounts[amounts.length - 1];

        // Build swap calldata
        const deadline = BigInt(Math.floor(Date.now() / 1000) + 1800); // 30 min
        const minOut = (amountOut * 995n) / 1000n; // 0.5% slippage

        const data = encodeFunctionData({
          abi: SUSHI_ROUTER_ABI,
          functionName: 'swapExactTokensForTokens',
          args: [amountIn, minOut, path, clients.address, deadline],
        });

        return {
          provider: this.name,
          tokenIn,
          tokenOut,
          amountIn,
          amountOut,
          to: routerAddress,
          data,
          value: 0n,
        };
      } catch {
        // Try with WETH hop
        if (tokenIn !== weth && tokenOut !== weth) {
          try {
            const pathWithHop: Address[] = [tokenIn, weth, tokenOut];
            const amounts = await publicClient.readContract({
              address: routerAddress,
              abi: SUSHI_ROUTER_ABI,
              functionName: 'getAmountsOut',
              args: [amountIn, pathWithHop],
            });

            const amountOut = amounts[amounts.length - 1];
            const deadline = BigInt(Math.floor(Date.now() / 1000) + 1800);
            const minOut = (amountOut * 995n) / 1000n;

            const data = encodeFunctionData({
              abi: SUSHI_ROUTER_ABI,
              functionName: 'swapExactTokensForTokens',
              args: [amountIn, minOut, pathWithHop, clients.address, deadline],
            });

            return {
              provider: this.name,
              tokenIn,
              tokenOut,
              amountIn,
              amountOut,
              to: routerAddress,
              data,
              value: 0n,
            };
          } catch {
            return null;
          }
        }
        return null;
      }
    },

    async execute(clients: Clients, quote: SwapQuote): Promise<`0x${string}`> {
      if (!quote.to || !quote.data) {
        throw new Error('Quote missing execution data');
      }

      const walletClient = getWalletClient(clients, chainId);
      const nonce = await getNextNonce(clients, chainId);

      const hash = await walletClient.sendTransaction({
        to: quote.to,
        data: quote.data,
        value: quote.value ?? 0n,
        nonce: Number(nonce),
      });

      diag.info('Swap tx submitted', {
        provider: quote.provider,
        tokenIn: quote.tokenIn,
        tokenOut: quote.tokenOut,
        amountIn: quote.amountIn.toString(),
        expectedOut: quote.amountOut.toString(),
        txHash: hash,
      });

      return hash;
    },
  };
}

export const sushiSwapEthereum = createSushiSwapProvider(CHAIN_ID_ETHEREUM);
export const sushiSwapHemi = createSushiSwapProvider(CHAIN_ID_HEMI);
