import { createHmac } from 'node:crypto';
import { verifyPaystackSignature } from './webhook-signature';

const secret = 'sk_test_secret';
const body = Buffer.from(
  '{"event":"charge.success","data":{"reference":"r1"}}',
);
const sign = (key: string, payload: Buffer) =>
  createHmac('sha512', key).update(payload).digest('hex');

describe('verifyPaystackSignature', () => {
  it('accepts the HMAC-SHA512 of the raw body', () => {
    expect(verifyPaystackSignature(secret, body, sign(secret, body))).toBe(
      true,
    );
  });

  it('rejects a body that changed after signing', () => {
    const signature = sign(secret, body);
    expect(
      verifyPaystackSignature(
        secret,
        Buffer.from('{"event":"charge.success","data":{"reference":"r2"}}'),
        signature,
      ),
    ).toBe(false);
  });

  it('rejects the same body re-serialised with different whitespace', () => {
    const signature = sign(secret, body);
    const reserialised = Buffer.from(
      JSON.stringify(JSON.parse(body.toString())),
    );
    expect(reserialised.equals(body)).toBe(true);
    const spaced = Buffer.from(
      JSON.stringify(JSON.parse(body.toString()), null, 1),
    );
    expect(verifyPaystackSignature(secret, spaced, signature)).toBe(false);
  });

  it('rejects a signature made with another secret', () => {
    expect(verifyPaystackSignature(secret, body, sign('other', body))).toBe(
      false,
    );
  });

  it('rejects a missing secret, a missing signature and malformed hex', () => {
    expect(verifyPaystackSignature(undefined, body, sign(secret, body))).toBe(
      false,
    );
    expect(verifyPaystackSignature('', body, sign(secret, body))).toBe(false);
    expect(verifyPaystackSignature(secret, body, undefined)).toBe(false);
    expect(verifyPaystackSignature(secret, body, '')).toBe(false);
    expect(verifyPaystackSignature(secret, body, 'not-hex')).toBe(false);
    expect(
      verifyPaystackSignature(secret, body, sign(secret, body).slice(0, 64)),
    ).toBe(false);
  });
});
