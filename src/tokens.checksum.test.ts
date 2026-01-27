import { describe, it } from 'vitest';
import { getAddress, isAddress } from 'viem';
import { TOKENS } from './tokens.js';

describe('Token Address Checksums', () => {
  it('all token addresses have valid checksums', () => {
    const errors: string[] = [];

    for (const [tokenId, token] of Object.entries(TOKENS)) {
      for (const [chainIdStr, chainInfo] of Object.entries(token.chains)) {
        const chainId = parseInt(chainIdStr, 10);
        
        // Skip if chainInfo is undefined
        if (!chainInfo) continue;
        
        const address = chainInfo.address;
        
        // Check if it's a valid address format
        if (!isAddress(address)) {
          errors.push(`${tokenId} on chain ${chainId}: "${address}" is not a valid address format`);
          continue;
        }

        // Check if checksum is correct
        try {
          const checksummed = getAddress(address);
          if (checksummed !== address) {
            errors.push(
              `${tokenId} on chain ${chainId}: Checksum mismatch.\n` +
              `  Found:    ${address}\n` +
              `  Expected: ${checksummed}`
            );
          }
        } catch (err) {
          errors.push(`${tokenId} on chain ${chainId}: Failed to validate checksum - ${err}`);
        }
      }
    }

    if (errors.length > 0) {
      throw new Error(
        `Token address checksum validation failed:\n\n${errors.join('\n\n')}`
      );
    }
  });

  it('all token addresses are 42 characters (0x + 40 hex)', () => {
    const errors: string[] = [];

    for (const [tokenId, token] of Object.entries(TOKENS)) {
      for (const [chainIdStr, chainInfo] of Object.entries(token.chains)) {
        const chainId = parseInt(chainIdStr, 10);
        
        // Skip if chainInfo is undefined
        if (!chainInfo) continue;
        
        const address = chainInfo.address;
        
        if (address.length !== 42) {
          errors.push(
            `${tokenId} on chain ${chainId}: Invalid length ${address.length}, expected 42`
          );
        }

        if (!address.startsWith('0x')) {
          errors.push(
            `${tokenId} on chain ${chainId}: Address must start with "0x"`
          );
        }
      }
    }

    if (errors.length > 0) {
      throw new Error(
        `Token address format validation failed:\n\n${errors.join('\n\n')}`
      );
    }
  });
});
