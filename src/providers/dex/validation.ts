import { type Address, getAddress, isHex } from 'viem';

/**
 * API response validation helpers.
 * Validate external API data before use to prevent type confusion attacks.
 */

/**
 * Validate and normalize an Ethereum address from API response.
 * Throws if invalid, returns checksummed address.
 */
export function validateAddress(addr: unknown, field: string): Address {
  if (typeof addr !== 'string') {
    throw new Error(`${field}: expected string, got ${typeof addr}`);
  }
  if (!addr || addr.length !== 42 || !addr.startsWith('0x')) {
    throw new Error(`${field}: invalid address format`);
  }
  // getAddress() throws if invalid, returns checksummed
  return getAddress(addr);
}

/**
 * Validate hex data from API response.
 * Throws if invalid, returns typed hex string.
 */
export function validateHex(data: unknown, field: string): `0x${string}` {
  if (typeof data !== 'string') {
    throw new Error(`${field}: expected string, got ${typeof data}`);
  }
  if (!isHex(data)) {
    throw new Error(`${field}: invalid hex format`);
  }
  return data as `0x${string}`;
}

/**
 * Validate and convert to bigint from API response.
 * Accepts string or number, throws if invalid or negative.
 */
export function validateBigInt(val: unknown, field: string): bigint {
  if (val === undefined || val === null) {
    throw new Error(`${field}: missing value`);
  }
  if (typeof val !== 'string' && typeof val !== 'number') {
    throw new Error(`${field}: expected string or number, got ${typeof val}`);
  }
  try {
    const n = BigInt(String(val));
    if (n < 0n) {
      throw new Error(`${field}: negative value not allowed`);
    }
    return n;
  } catch (err) {
    if (err instanceof Error && err.message.includes(field)) {
      throw err;
    }
    throw new Error(`${field}: invalid bigint format`);
  }
}

/**
 * Validate optional bigint (returns 0n if missing/empty).
 */
export function validateOptionalBigInt(val: unknown, field: string): bigint {
  if (val === undefined || val === null || val === '') {
    return 0n;
  }
  return validateBigInt(val, field);
}
