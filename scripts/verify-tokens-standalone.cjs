#!/usr/bin/env node
const { createPublicClient, http, parseAbi } = require('viem');

const CHAIN_ID_HEMI = 43111;
const CHAIN_ID_ETHEREUM = 1;

const TOKENS = {
  VCRED: {
    symbol: 'VCRED',
    decimals: 6,
    addresses: { [CHAIN_ID_HEMI]: '0x71881974e96152643C74A8e0214B877CfB2A0Aa1' },
  },
  USDC: {
    symbol: 'USDC',
    decimals: 6,
    addresses: {
      [CHAIN_ID_ETHEREUM]: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
      [CHAIN_ID_HEMI]: '0xad11a8BEb98bbf61dbb1aa0F6d6F2ECD87b35afA',
    },
  },
  WETH: {
    symbol: 'WETH',
    decimals: 18,
    addresses: {
      [CHAIN_ID_ETHEREUM]: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
      [CHAIN_ID_HEMI]: '0x4200000000000000000000000000000000000006',
    },
  },
  WBTC: {
    symbol: 'WBTC',
    decimals: 8,
    addresses: { [CHAIN_ID_ETHEREUM]: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599' },
  },
  hemiBTC: {
    symbol: 'hemiBTC',
    decimals: 8,
    addresses: { [CHAIN_ID_HEMI]: '0xAA40c0c7644e0b2B224509571e10ad20d9C4ef28' },
  },
  cbBTC: {
    symbol: 'cbBTC',
    decimals: 8,
    addresses: {
      [CHAIN_ID_ETHEREUM]: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf',
      [CHAIN_ID_HEMI]: '0x1596bE338B999E2376675C908168A7548C8B0525',
    },
  },
  XAUt: {
    symbol: 'XAUt',
    decimals: 6,
    addresses: {
      [CHAIN_ID_ETHEREUM]: '0x68749665FF8D2d112Fa859AA293F07A622782F38',
      [CHAIN_ID_HEMI]: '0x028DE74e2fE336511A8E5FAb0426D1cfD5110DBb',
    },
  },
  VUSD: {
    symbol: 'VUSD',
    decimals: 18,
    addresses: {
      [CHAIN_ID_ETHEREUM]: '0x677ddbd918637E5F2c79e164D402454dE7dA8619',
      [CHAIN_ID_HEMI]: '0x7A06C4AeF988e7925575C50261297a946aD204A8',
    },
  },
};

const ERC20_ABI = parseAbi([
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
]);

const hemiClient = createPublicClient({
  transport: http('https://rpc.hemi.network/rpc'),
});

const ethClient = createPublicClient({
  transport: http('https://eth.llamarpc.com'),
});

async function verifyTokenAddress(tokenId, expectedSymbol, expectedDecimals, chainId, address) {
  const client = chainId === CHAIN_ID_HEMI ? hemiClient : ethClient;
  const chainName = chainId === CHAIN_ID_HEMI ? 'Hemi' : 'Ethereum';
  
  console.log(`\nVerifying ${tokenId} on ${chainName} (${address})...`);
  
  try {
    // Check if contract exists
    const bytecode = await client.getBytecode({ address });
    if (!bytecode || bytecode === '0x') {
      console.error(`  ❌ ERROR: No contract code at address ${address}`);
      return false;
    }
    console.log(`  ✓ Contract exists`);
    
    // Read ERC-20 properties
    const [symbol, decimals, name, totalSupply] = await Promise.all([
      client.readContract({ address, abi: ERC20_ABI, functionName: 'symbol' }).catch(() => null),
      client.readContract({ address, abi: ERC20_ABI, functionName: 'decimals' }).catch(() => null),
      client.readContract({ address, abi: ERC20_ABI, functionName: 'name' }).catch(() => null),
      client.readContract({ address, abi: ERC20_ABI, functionName: 'totalSupply' }).catch(() => null),
    ]);
    
    console.log(`  Name: ${name}`);
    console.log(`  Symbol: ${symbol}`);
    console.log(`  Decimals: ${decimals}`);
    console.log(`  Total Supply: ${totalSupply ? totalSupply.toString() : 'N/A'}`);
    
    // Verify symbol matches (case-insensitive), allow USDC.e as equivalent to USDC
    const symbolMatch = symbol && (
      symbol.toUpperCase() === expectedSymbol.toUpperCase() ||
      (expectedSymbol === 'USDC' && symbol === 'USDC.e')
    );
    if (!symbolMatch) {
      console.error(`  ❌ ERROR: Symbol mismatch! Expected \"${expectedSymbol}\", got \"${symbol}\"`);
      return false;
    }
    console.log(`  ✓ Symbol matches`);
    
    // Verify decimals match
    if (decimals !== expectedDecimals) {
      console.error(`  ❌ ERROR: Decimals mismatch! Expected ${expectedDecimals}, got ${decimals}`);
      return false;
    }
    console.log(`  ✓ Decimals match`);
    
    console.log(`  ✅ ${tokenId} on ${chainName} verified successfully`);
    return true;
  } catch (err) {
    console.error(`  ❌ ERROR: Failed to verify - ${err.message}`);
    return false;
  }
}

async function main() {
  console.log('='.repeat(60));
  console.log('Token Address Verification');
  console.log('='.repeat(60));
  
  const results = [];
  
  for (const [tokenId, token] of Object.entries(TOKENS)) {
    for (const [chainIdStr, address] of Object.entries(token.addresses)) {
      const chainId = parseInt(chainIdStr, 10);
      const chainName = chainId === CHAIN_ID_HEMI ? 'Hemi' : chainId === CHAIN_ID_ETHEREUM ? 'Ethereum' : `Chain ${chainId}`;
      
      const success = await verifyTokenAddress(tokenId, token.symbol, token.decimals, chainId, address);
      
      results.push({ token: `${tokenId} (${chainName})`, chain: chainName, success });
    }
  }
  
  console.log('\n' + '='.repeat(60));
  console.log('Summary');
  console.log('='.repeat(60));
  
  const successful = results.filter(r => r.success);
  const failed = results.filter(r => !r.success);
  
  console.log(`✅ Verified: ${successful.length}/${results.length}`);
  
  if (failed.length > 0) {
    console.log(`❌ Failed: ${failed.length}`);
    console.log('\nFailed verifications:');
    for (const f of failed) {
      console.log(`  - ${f.token}`);
    }
    process.exit(1);
  } else {
    console.log('\n🎉 All token addresses verified successfully!');
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
