import { describe, it, expect } from 'vitest';
import { getToken, getTokenAddress, getTokenDecimals, requireTokenAddress, requireTokenDecimals, TOKENS, ARB_TARGET_TOKENS } from './tokens.js';
import { CHAIN_ID_HEMI, CHAIN_ID_ETHEREUM } from './chains.js';

describe('tokens', () => {
  describe('getToken', () => {
    it('returns VCRED token metadata', () => {
      const token = getToken('VCRED');
      expect(token.symbol).toBe('VCRED');
      expect(token.chains[CHAIN_ID_HEMI]?.decimals).toBe(6);
      expect(token.chains[CHAIN_ID_HEMI]?.address).toBeDefined();
    });

    it('returns USDC token metadata', () => {
      const token = getToken('USDC');
      expect(token.symbol).toBe('USDC');
      expect(token.chains[CHAIN_ID_ETHEREUM]?.decimals).toBe(6);
      expect(token.chains[CHAIN_ID_ETHEREUM]?.address).toBeDefined();
    });

    it('returns correct decimals for all tokens on their respective chains', () => {
      expect(getTokenDecimals('VCRED', CHAIN_ID_HEMI)).toBe(6);
      expect(getTokenDecimals('USDC', CHAIN_ID_ETHEREUM)).toBe(6);
      expect(getTokenDecimals('WETH', CHAIN_ID_ETHEREUM)).toBe(18);
      expect(getTokenDecimals('WBTC', CHAIN_ID_ETHEREUM)).toBe(8);
      expect(getTokenDecimals('hemiBTC', CHAIN_ID_HEMI)).toBe(8);
      expect(getTokenDecimals('cbBTC', CHAIN_ID_ETHEREUM)).toBe(8);
      expect(getTokenDecimals('XAUt', CHAIN_ID_ETHEREUM)).toBe(6);
      expect(getTokenDecimals('VUSD', CHAIN_ID_ETHEREUM)).toBe(18);
    });
  });

  describe('getTokenAddress', () => {
    it('returns address for token on correct chain', () => {
      const vcredHemi = getTokenAddress('VCRED', CHAIN_ID_HEMI);
      expect(vcredHemi).toBe('0x71881974e96152643C74A8e0214B877CfB2A0Aa1');

      const usdcEth = getTokenAddress('USDC', CHAIN_ID_ETHEREUM);
      expect(usdcEth).toBe('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48');
    });

    it('returns undefined for token not on chain', () => {
      const vcredEth = getTokenAddress('VCRED', CHAIN_ID_ETHEREUM);
      expect(vcredEth).toBeUndefined();
    });
  });

  describe('requireTokenAddress', () => {
    it('returns address when token exists on chain', () => {
      const addr = requireTokenAddress('VCRED', CHAIN_ID_HEMI);
      expect(addr).toBe('0x71881974e96152643C74A8e0214B877CfB2A0Aa1');
    });

    it('throws when token not on chain', () => {
      expect(() => requireTokenAddress('VCRED', CHAIN_ID_ETHEREUM)).toThrow(
        'Token VCRED not available on chain 1'
      );
    });
  });

  describe('ARB_TARGET_TOKENS', () => {
    it('contains expected tokens', () => {
      expect(ARB_TARGET_TOKENS).toContain('WETH');
      expect(ARB_TARGET_TOKENS).toContain('WBTC');
      expect(ARB_TARGET_TOKENS).toContain('hemiBTC');
    });

    it('does not contain VCRED (source token)', () => {
      expect(ARB_TARGET_TOKENS).not.toContain('VCRED');
    });

    it('does not contain USDC (intermediate token)', () => {
      expect(ARB_TARGET_TOKENS).not.toContain('USDC');
    });
  });

  describe('bridge routes', () => {
    it('WETH uses Stargate', () => {
      expect(TOKENS.WETH.bridgeRouteOut).toBe('STARGATE_LZ');
    });

    it('hemiBTC uses Stargate', () => {
      expect(TOKENS.hemiBTC.bridgeRouteOut).toBe('STARGATE_LZ');
    });

    it('WBTC uses Hemi tunnel', () => {
      expect(TOKENS.WBTC.bridgeRouteOut).toBe('HEMI_TUNNEL');
    });

    it('XAUt uses Hemi tunnel', () => {
      expect(TOKENS.XAUt.bridgeRouteOut).toBe('HEMI_TUNNEL');
    });
  });
});
