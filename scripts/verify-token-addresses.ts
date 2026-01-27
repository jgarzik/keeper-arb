#!/usr/bin/env tsx
import { createPublicClient, http, parseAbi } from 'viem';
import { TOKENS } from '../src/tokens.js';
import { hemiMainnet, ethereumMainnet } from '../src/chains.js';
import { RPC_URLS } from '../src/rpc.js';

const ERC20_ABI = parseAbi([
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
]);

const hemiClient = createPublicClient({
  chain: hemiMainnet,
  transport: http(RPC_URLS.hemi),
});

const ethClient = createPublicClient({
  chain: ethereumMainnet,
  transport: http(RPC_URLS.ethereum),
});

async function verifyTokenAddress(
  tokenId: string,
  expectedSymbol: string,
  expectedDecimals: number,
  chainId: number,
  address: string
) {
  const client = chainId === 43111 ? hemiClient : ethClient;
  const chainName = chainId === 43111 ? 'Hemi' : 'Ethereum';
  
  console.log(`\nVerifying ${tokenId} on ${chainName} (${address})...`);
  
  try {
    // Check if contract exists
    const bytecode = await client.getBytecode({ address: address as `0x${string}` });
    if (!bytecode || bytecode === '0x') {
      console.error(`  ❌ ERROR: No contract code at address ${address}`);
      return false;
    }
    console.log(`  ✓ Contract exists`);
    
    // Read ERC-20 properties
    const [symbol, decimals, name, totalSupply] = await Promise.all([
      client.readContract({
        address: address as `0x${string}`,
        abi: ERC20_ABI,
        functionName: 'symbol',
      }).catch(() => null),
      client.readContract({
        address: address as `0x${string}`,
        abi: ERC20_ABI,
        functionName: 'decimals',
      }).catch(() => null),
      client.readContract({
        address: address as `0x${string}`,
        abi: ERC20_ABI,
        functionName: 'name',
      }).catch(() => null),
      client.readContract({
        address: address as `0x${string}`,
        abi: ERC20_ABI,
        functionName: 'totalSupply',
      }).catch(() => null),
    ]);
    
    console.log(`  Name: ${name}`);
    console.log(`  Symbol: ${symbol}`);
    console.log(`  Decimals: ${decimals}`);
    console.log(`  Total Supply: ${totalSupply ? totalSupply.toString() : 'N/A'}`);
    
    // Verify symbol matches (case-insensitive)
    if (symbol && symbol.toUpperCase() !== expectedSymbol.toUpperCase()) {
      console.error(`  ❌ ERROR: Symbol mismatch! Expected "${expectedSymbol}", got "${symbol}"`);
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
    console.error(`  ❌ ERROR: Failed to verify - ${err}`);
    return false;
  }
}

async function main() {
  console.log('='.repeat(60));
  console.log('Token Address Verification');
  console.log('='.repeat(60));
  
  const results: { token: string; chain: string; success: boolean }[] = [];
  
  for (const [tokenId, token] of Object.entries(TOKENS)) {
    for (const [chainIdStr, address] of Object.entries(token.addresses)) {
      const chainId = parseInt(chainIdStr, 10);
      const chainName = chainId === 43111 ? 'Hemi' : chainId === 1 ? 'Ethereum' : `Chain ${chainId}`;
      
      const success = await verifyTokenAddress(
        tokenId,
        token.symbol,
        token.decimals,
        chainId,
        address
      );
      
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
