import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock logging before importing cowswapApi
vi.mock('../../logging.js', () => ({
  diag: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  logMoney: vi.fn(),
}));

import { cowswapApiProvider, buildPreSignatureTx, createCowSwapOrder, getCowSwapOrderStatus } from './cowswapApi.js';
import { COWSWAP_SETTLEMENT, COWSWAP_VAULT_RELAYER } from '../../constants/api.js';

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const MOCK_SENDER = '0x1111111111111111111111111111111111111111' as const;
const MOCK_TOKEN_IN = '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599' as const; // cbBTC
const MOCK_TOKEN_OUT = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' as const; // USDC

const MOCK_QUOTE_RESPONSE = {
  quote: {
    sellToken: MOCK_TOKEN_IN.toLowerCase(),
    buyToken: MOCK_TOKEN_OUT.toLowerCase(),
    sellAmount: '2300000',  // after fee
    buyAmount: '176100000', // ~$1,761 USDC for 0.023 BTC
    feeAmount: '100000',
    kind: 'sell',
    partiallyFillable: false,
    validTo: Math.floor(Date.now() / 1000) + 1800,
    appData: '0x0000000000000000000000000000000000000000000000000000000000000000',
    receiver: MOCK_SENDER.toLowerCase(),
    sellTokenBalance: 'erc20',
    buyTokenBalance: 'erc20',
  },
  from: MOCK_SENDER.toLowerCase(),
  id: 42,
};

describe('CowSwap API Provider', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('getQuote', () => {
    it('returns a valid quote for Ethereum', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(MOCK_QUOTE_RESPONSE),
      });

      const quote = await cowswapApiProvider.getQuote(
        1, // Ethereum
        MOCK_TOKEN_IN,
        MOCK_TOKEN_OUT,
        2400000n,
        MOCK_SENDER,
        0.01,
        8, // cbBTC decimals
        6  // USDC decimals
      );

      expect(quote).not.toBeNull();
      expect(quote!.provider).toBe('cowswap');
      expect(quote!.chainId).toBe(1);
      expect(quote!.amountOut).toBe(176100000n);
      expect(quote!.spender).toBe(COWSWAP_VAULT_RELAYER);
    });

    it('returns null for unsupported chains', async () => {
      const quote = await cowswapApiProvider.getQuote(
        43111, // Hemi
        MOCK_TOKEN_IN,
        MOCK_TOKEN_OUT,
        2400000n,
        MOCK_SENDER,
        0.01,
        8,
        6
      );

      expect(quote).toBeNull();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('returns null on API error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: () => Promise.resolve('Bad Request'),
      });

      const quote = await cowswapApiProvider.getQuote(
        1,
        MOCK_TOKEN_IN,
        MOCK_TOKEN_OUT,
        2400000n,
        MOCK_SENDER,
        0.01,
        8,
        6
      );

      expect(quote).toBeNull();
    });
  });

  describe('buildPreSignatureTx', () => {
    it('builds valid setPreSignature calldata', () => {
      const mockUid = '0x' + 'ab'.repeat(56);
      const tx = buildPreSignatureTx(mockUid);

      expect(tx.to).toBe(COWSWAP_SETTLEMENT);
      expect(tx.value).toBe(0n);
      expect(tx.data).toMatch(/^0x/);
      // setPreSignature selector: 0xec6cb13f
      expect(tx.data.slice(0, 10)).toBe('0xec6cb13f');
    });
  });

  describe('createCowSwapOrder', () => {
    it('creates order and returns UID', async () => {
      const mockUid = '0x' + 'cd'.repeat(56);
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockUid),
      });

      const uid = await createCowSwapOrder(MOCK_QUOTE_RESPONSE, MOCK_SENDER, 174339000n);

      expect(uid).toBe(mockUid);
      expect(mockFetch).toHaveBeenCalledOnce();

      const callArgs = mockFetch.mock.calls[0];
      expect(callArgs[0]).toContain('/orders');
      const body = JSON.parse(callArgs[1].body);
      expect(body.signingScheme).toBe('presign');
      expect(body.from).toBe(MOCK_SENDER);
      expect(body.buyAmount).toBe('174339000');
    });
  });

  describe('getCowSwapOrderStatus', () => {
    it('returns order status', async () => {
      const mockUid = '0x' + 'ef'.repeat(56);
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          status: 'fulfilled',
          executedBuyAmount: '176000000',
          executedSellAmount: '2300000',
        }),
      });

      const info = await getCowSwapOrderStatus(mockUid);

      expect(info.status).toBe('fulfilled');
      expect(info.executedBuyAmount).toBe('176000000');
      expect(info.uid).toBe(mockUid);
    });

    it('throws on API error', async () => {
      const mockUid = '0x' + 'ef'.repeat(56);
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
      });

      await expect(getCowSwapOrderStatus(mockUid)).rejects.toThrow('CowSwap order status HTTP 404');
    });
  });
});
