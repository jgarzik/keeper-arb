/**
 * Contract addresses used across the keeper
 */
import { type Address } from 'viem';
import { CHAIN_ID_ETHEREUM, CHAIN_ID_HEMI } from '../chains.js';

// Hemi OP-stack contracts
export const HEMI_OPTIMISM_PORTAL: Address = '0x39a0005415256B9863aFE2d55Edcf75ECc3A4D7e';
export const HEMI_L2_OUTPUT_ORACLE: Address = '0x6daF3a3497D8abdFE12915aDD9829f83A79C0d51';
export const HEMI_L1_STANDARD_BRIDGE: Address = '0x5eaa10F99e7e6D177eF9F74E519E319aa49f191e';
export const HEMI_L2_STANDARD_BRIDGE: Address = '0x4200000000000000000000000000000000000010';
export const L2_TO_L1_MESSAGE_PASSER: Address = '0x4200000000000000000000000000000000000016';

// Stargate V2 contracts - Native ETH pool (keyed by chainId)
export const STARGATE_POOL_NATIVE: Record<number, Address> = {
  [CHAIN_ID_ETHEREUM]: '0x77b2043768d28E9C9aB44E1aBfC95944bcE57931',
  [CHAIN_ID_HEMI]: '0x2F6F07CDcf3588944Bf4C42aC74ff24bF56e7590',
};

// Stargate V2 contracts - USDC OFT (Omnichain Fungible Token) (keyed by chainId)
export const STARGATE_OFT_USDC: Record<number, Address> = {
  [CHAIN_ID_ETHEREUM]: '0xc026395860Db2d07ee33e05fE50ed7bD583189C7',
  [CHAIN_ID_HEMI]: '0x45f1A95A4D3f3836523F5c83673c797f4d4d263B',
};

// LayerZero Endpoint IDs (keyed by chainId)
export const LZ_ENDPOINT_IDS: Record<number, number> = {
  [CHAIN_ID_ETHEREUM]: 30101,
  [CHAIN_ID_HEMI]: 30329,
};

// Uniswap V3 Quoter V2 on Ethereum
export const UNISWAP_QUOTER_V2: Address = '0x61fFE014bA17989E743c5F6cB21bF9697530B21e';
