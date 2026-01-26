import { type Address, encodeFunctionData, parseAbi } from 'viem';
import { type Clients, getPublicClient, getWalletClient, getNextNonce } from '../wallet.js';
import { type SwapProvider, type SwapQuote } from './swapInterface.js';
import { CHAIN_ID_HEMI, CHAIN_ID_ETHEREUM } from '../chains.js';
import { diag } from '../logging.js';

// SushiSwap V2 Router ABI (Ethereum)
const SUSHI_V2_ROUTER_ABI = parseAbi([
  'function getAmountsOut(uint amountIn, address[] path) view returns (uint[] amounts)',
  'function swapExactTokensForTokens(uint amountIn, uint amountOutMin, address[] path, address to, uint deadline) returns (uint[] amounts)',
  'function swapExactETHForTokens(uint amountOutMin, address[] path, address to, uint deadline) payable returns (uint[] amounts)',
  'function swapExactTokensForETH(uint amountIn, uint amountOutMin, address[] path, address to, uint deadline) returns (uint[] amounts)',
]);

// SushiSwap V3 SwapRouter ABI (Hemi)
const SUSHI_V3_ROUTER_ABI = [
  {
    name: 'exactInputSingle',
    type: 'function',
    stateMutability: 'payable',
    inputs: [
      {
        name: 'params',
        type: 'tuple',
        components: [
          { name: 'tokenIn', type: 'address' },
          { name: 'tokenOut', type: 'address' },
          { name: 'fee', type: 'uint24' },
          { name: 'recipient', type: 'address' },
          { name: 'amountIn', type: 'uint256' },
          { name: 'amountOutMinimum', type: 'uint256' },
          { name: 'sqrtPriceLimitX96', type: 'uint160' },
        ],
      },
    ],
    outputs: [{ name: 'amountOut', type: 'uint256' }],
  },
] as const;

// SushiSwap V3 QuoterV2 ABI
const SUSHI_V3_QUOTER_ABI = [
  {
    name: 'quoteExactInputSingle',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'params',
        type: 'tuple',
        components: [
          { name: 'tokenIn', type: 'address' },
          { name: 'tokenOut', type: 'address' },
          { name: 'amountIn', type: 'uint256' },
          { name: 'fee', type: 'uint24' },
          { name: 'sqrtPriceLimitX96', type: 'uint160' },
        ],
      },
    ],
    outputs: [
      { name: 'amountOut', type: 'uint256' },
      { name: 'sqrtPriceX96After', type: 'uint160' },
      { name: 'initializedTicksCrossed', type: 'uint32' },
      { name: 'gasEstimate', type: 'uint256' },
    ],
  },
] as const;

// V2 router addresses
const SUSHI_V2_ROUTERS: Record<number, Address> = {
  [CHAIN_ID_ETHEREUM]: '0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F',
};

// V3 router addresses (Hemi)
const SUSHI_V3_ROUTERS: Record<number, Address> = {
  [CHAIN_ID_HEMI]: '0x33d91116e0370970444B0281AB117e161fEbFcdD',
};

// V3 quoter addresses (Hemi)
const SUSHI_V3_QUOTERS: Record<number, Address> = {
  [CHAIN_ID_HEMI]: '0x1400feFD6F9b897970f00Df6237Ff2B8b27Dc82C',
};

// WETH addresses for native ETH swaps
const WETH: Record<number, Address> = {
  [CHAIN_ID_ETHEREUM]: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
  [CHAIN_ID_HEMI]: '0x4200000000000000000000000000000000000006',
};

// Common V3 fee tiers to try
const FEE_TIERS = [500, 3000, 10000] as const; // 0.05%, 0.3%, 1%

// Determine which version to use for a chain
function isV3Chain(chainId: number): boolean {
  return chainId === CHAIN_ID_HEMI;
}

// V3 quote implementation for Hemi
async function quoteV3(
  clients: Clients,
  chainId: number,
  tokenIn: Address,
  tokenOut: Address,
  amountIn: bigint
): Promise<{ amountOut: bigint; fee: number } | null> {
  const quoterAddress = SUSHI_V3_QUOTERS[chainId];
  if (!quoterAddress) {
    return null;
  }

  const publicClient = getPublicClient(clients, chainId);

  // Try each fee tier
  for (const fee of FEE_TIERS) {
    try {
      const result = await publicClient.readContract({
        address: quoterAddress,
        abi: SUSHI_V3_QUOTER_ABI,
        functionName: 'quoteExactInputSingle',
        args: [
          {
            tokenIn,
            tokenOut,
            amountIn,
            fee,
            sqrtPriceLimitX96: 0n,
          },
        ],
      }) as readonly [bigint, bigint, number, bigint];

      const amountOut = result[0];

      diag.debug('SushiSwap V3 quote', {
        chainId,
        tokenIn,
        tokenOut,
        amountIn: amountIn.toString(),
        amountOut: amountOut.toString(),
        feeTier: fee,
      });

      return { amountOut, fee };
    } catch {
      // Try next fee tier
      continue;
    }
  }

  return null;
}

// V2 quote implementation for Ethereum
async function quoteV2(
  clients: Clients,
  chainId: number,
  tokenIn: Address,
  tokenOut: Address,
  amountIn: bigint
): Promise<{ amountOut: bigint; path: Address[] } | null> {
  const routerAddress = SUSHI_V2_ROUTERS[chainId];
  if (!routerAddress) {
    return null;
  }

  const publicClient = getPublicClient(clients, chainId);
  const weth = WETH[chainId];

  // Try direct path
  try {
    const path: Address[] = [tokenIn, tokenOut];
    const amounts = await publicClient.readContract({
      address: routerAddress,
      abi: SUSHI_V2_ROUTER_ABI,
      functionName: 'getAmountsOut',
      args: [amountIn, path],
    });

    return { amountOut: amounts[amounts.length - 1], path };
  } catch {
    // Try with WETH hop
    if (tokenIn !== weth && tokenOut !== weth) {
      try {
        const pathWithHop: Address[] = [tokenIn, weth, tokenOut];
        const amounts = await publicClient.readContract({
          address: routerAddress,
          abi: SUSHI_V2_ROUTER_ABI,
          functionName: 'getAmountsOut',
          args: [amountIn, pathWithHop],
        });

        return { amountOut: amounts[amounts.length - 1], path: pathWithHop };
      } catch {
        return null;
      }
    }
    return null;
  }
}

function createSushiSwapProvider(chainId: number): SwapProvider {
  const weth = WETH[chainId];
  const isV3 = isV3Chain(chainId);

  return {
    name: `SushiSwap-${chainId}`,
    chainId,

    async quoteExactIn(
      clients: Clients,
      tokenIn: Address,
      tokenOut: Address,
      amountIn: bigint
    ): Promise<SwapQuote | null> {
      if (isV3) {
        // V3 path for Hemi
        const routerAddress = SUSHI_V3_ROUTERS[chainId];
        if (!routerAddress) {
          diag.warn('SushiSwap V3 router not configured for chain', { chainId });
          return null;
        }

        const quoteResult = await quoteV3(clients, chainId, tokenIn, tokenOut, amountIn);
        if (!quoteResult) {
          // Try with WETH hop
          if (tokenIn !== weth && tokenOut !== weth) {
            const firstLeg = await quoteV3(clients, chainId, tokenIn, weth, amountIn);
            if (firstLeg) {
              const secondLeg = await quoteV3(clients, chainId, weth, tokenOut, firstLeg.amountOut);
              if (secondLeg) {
                // For multi-hop, we'd need to use exactInput with path encoding
                // For simplicity, return null and let other providers handle it
                diag.debug('SushiSwap V3 multi-hop not implemented', { chainId });
                return null;
              }
            }
          }
          return null;
        }

        const { amountOut, fee } = quoteResult;
        const minOut = (amountOut * 995n) / 1000n; // 0.5% slippage

        const data = encodeFunctionData({
          abi: SUSHI_V3_ROUTER_ABI,
          functionName: 'exactInputSingle',
          args: [
            {
              tokenIn,
              tokenOut,
              fee,
              recipient: clients.address,
              amountIn,
              amountOutMinimum: minOut,
              sqrtPriceLimitX96: 0n,
            },
          ],
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
      } else {
        // V2 path for Ethereum
        const routerAddress = SUSHI_V2_ROUTERS[chainId];
        if (!routerAddress) {
          diag.warn('SushiSwap V2 router not configured for chain', { chainId });
          return null;
        }

        const quoteResult = await quoteV2(clients, chainId, tokenIn, tokenOut, amountIn);
        if (!quoteResult) {
          return null;
        }

        const { amountOut, path } = quoteResult;
        const deadline = BigInt(Math.floor(Date.now() / 1000) + 1800); // 30 min
        const minOut = (amountOut * 995n) / 1000n; // 0.5% slippage

        const data = encodeFunctionData({
          abi: SUSHI_V2_ROUTER_ABI,
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
