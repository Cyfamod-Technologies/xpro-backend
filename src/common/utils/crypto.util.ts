import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
} from 'crypto';

/**
 * Computes an HMAC-SHA256 signature over the exact raw payload string using the
 * endpoint's signing secret. Used to sign outbound webhook deliveries.
 */
export function signHmacSha256(secret: string, rawPayload: string): string {
  return createHmac('sha256', secret).update(rawPayload, 'utf8').digest('hex');
}

/**
 * Symmetric encryption for credentials at rest (DB passwords, API auth values,
 * webhook signing secrets). Uses AES-256-CBC and returns `ivHex:cipherHex`.
 *
 * Set ENCRYPTION_KEY (min 32 chars) in the environment. Without it a fallback
 * dev key is used — NOT safe for production.
 *
 * The plaintext value is NEVER returned to clients; only ciphertext is stored.
 */
function resolveKey(): Buffer {
  const rawKey = process.env.ENCRYPTION_KEY;
  if (!rawKey) {
    throw new Error('ENCRYPTION_KEY environment variable is not set');
  }
  return Buffer.from(rawKey.padEnd(32, '0').slice(0, 32), 'utf8');
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-cbc', resolveKey(), iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  return `${iv.toString('hex')}:${encrypted.toString('hex')}`;
}

export function decryptSecret(ciphertext: string): string {
  const [ivHex, encryptedHex] = ciphertext.split(':');
  const iv = Buffer.from(ivHex, 'hex');
  const encrypted = Buffer.from(encryptedHex, 'hex');
  const decipher = createDecipheriv('aes-256-cbc', resolveKey(), iv);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString(
    'utf8',
  );
}
