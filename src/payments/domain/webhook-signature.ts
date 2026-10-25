import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Paystack signs the raw request body with HMAC-SHA512 using the secret key
 * and sends the hex digest in `x-paystack-signature`. Compare the bytes that
 * arrived, in constant time; never re-serialise the parsed JSON.
 */
export function verifyPaystackSignature(
  secret: string | undefined,
  rawBody: Buffer,
  signature: string | undefined,
): boolean {
  if (!secret || !signature) return false;
  const expected = createHmac('sha512', secret).update(rawBody).digest();
  const actual = Buffer.from(signature, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
