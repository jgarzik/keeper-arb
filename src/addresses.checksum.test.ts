import { describe, it, expect } from 'vitest';
import { getAddress, isAddress, type Address } from 'viem';

// Import all modules with hardcoded addresses
import * as uniswapRef from './providers/uniswapRef.js';
import * as sushiSwap from './providers/sushiSwap.js';
import * as stargateBridge from './providers/stargateBridge.js';
import * as hemiTunnel from './providers/hemiTunnel.js';

describe('Hardcoded Address Checksums', () => {
  const extractAddressesFromModule = (module: any, moduleName: string): Array<{ path: string; address: string }> => {
    const addresses: Array<{ path: string; address: string }> = [];
    
    const traverse = (obj: any, path: string) => {
      if (typeof obj === 'string' && /^0x[0-9a-fA-F]{40}$/.test(obj)) {
        addresses.push({ path: `${moduleName}.${path}`, address: obj });
      } else if (typeof obj === 'object' && obj !== null) {
        for (const [key, value] of Object.entries(obj)) {
          traverse(value, path ? `${path}.${key}` : key);
        }
      }
    };
    
    traverse(module, '');
    return addresses;
  };

  it('all hardcoded addresses have valid checksums', () => {
    const modules = [
      { name: 'uniswapRef', module: uniswapRef },
      { name: 'sushiSwap', module: sushiSwap },
      { name: 'stargateBridge', module: stargateBridge },
      { name: 'hemiTunnel', module: hemiTunnel },
    ];

    const errors: string[] = [];

    for (const { name, module } of modules) {
      const addresses = extractAddressesFromModule(module, name);
      
      for (const { path, address } of addresses) {
        // Skip if not a valid address format
        if (!isAddress(address)) {
          errors.push(`${path}: "${address}" is not a valid address format`);
          continue;
        }

        // Check checksum
        try {
          const checksummed = getAddress(address);
          if (checksummed !== address) {
            errors.push(
              `${path}: Checksum mismatch.\n` +
              `  Found:    ${address}\n` +
              `  Expected: ${checksummed}`
            );
          }
        } catch (err) {
          errors.push(`${path}: Failed to validate checksum - ${err}`);
        }
      }
    }

    if (errors.length > 0) {
      throw new Error(
        `Hardcoded address checksum validation failed:\n\n${errors.join('\n\n')}`
      );
    }
  });

  // Specific known addresses to validate
  const KNOWN_ADDRESSES: Record<string, Address> = {
    'Ethereum USDC': '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    'Ethereum WETH': '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
    'Ethereum WBTC': '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599',
    'Hemi WETH': '0x4200000000000000000000000000000000000006',
    'Hemi L2 Standard Bridge': '0x4200000000000000000000000000000000000010',
  };

  it('known Ethereum addresses have correct checksums', () => {
    for (const [name, address] of Object.entries(KNOWN_ADDRESSES)) {
      expect(isAddress(address), `${name} should be valid address`).toBe(true);
      expect(getAddress(address), `${name} should have correct checksum`).toBe(address);
    }
  });
});
