import { ConfigService } from '@nestjs/config';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';
import { decryptSecret } from '../common/utils/crypto.util';
import { PhoneVerificationService } from './phone-verification.service';

const prisma = new PrismaClient();
const key = 'phone-test-encryption-key-32-characters';

describe('phone verification', () => {
  const users: string[] = [];
  const queued = jest.fn().mockResolvedValue({});
  const audit = { record: jest.fn() };
  const sms = { requireConfigured: jest.fn() };
  const service = new PhoneVerificationService(
    prisma as never,
    new ConfigService({ ENCRYPTION_KEY: key }),
    sms as never,
    { addSmsJob: queued } as never,
    audit as never,
  );
  const originalKey = process.env.ENCRYPTION_KEY;

  async function user() {
    const row = await prisma.user.create({
      data: {
        email: `${randomUUID()}@phone-test.example`,
        status: 'active',
        emailVerifiedAt: new Date(),
      },
    });
    users.push(row.id);
    return row.id;
  }

  const code = () =>
    decryptSecret(
      (queued.mock.calls.at(-1) as [{ encryptedCode: string }])[0]
        .encryptedCode,
    );

  beforeAll(() => {
    process.env.ENCRYPTION_KEY = key;
  });
  beforeEach(() => {
    jest.clearAllMocks();
  });
  afterEach(async () => {
    await prisma.user.deleteMany({ where: { id: { in: users.splice(0) } } });
  });
  afterAll(async () => {
    if (originalKey === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = originalKey;
    await prisma.$disconnect();
  });

  it('normalizes the account phone and verifies only a valid, single-use code', async () => {
    const id = await user();
    const challenge = await service.start(id, '0803 123 4567');
    const otp = code();
    const record = await prisma.phoneVerification.findUniqueOrThrow({
      where: { id: challenge.verificationId },
    });
    expect(record.codeHash).not.toBe(otp);
    expect(JSON.stringify(challenge)).not.toContain('+2348031234567');
    expect(queued.mock.calls[0][0]).not.toHaveProperty('code');
    const before = await prisma.user.findUniqueOrThrow({ where: { id } });
    expect(before.phoneVerifiedAt).toBeNull();
    const result = await service.confirm(id, challenge.verificationId, otp);
    expect(result).toMatchObject({
      phone: '+2348031234567',
      phoneVerified: true,
    });
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id } })).phoneVerifiedAt,
    ).not.toBeNull();
    await expect(
      service.confirm(id, challenge.verificationId, otp),
    ).rejects.toThrow('expired');
  });

  it('commits failed attempts and expires the code after five guesses', async () => {
    const id = await user();
    const challenge = await service.start(id, '08031234567');
    const otp = code();
    const wrong = otp === '000000' ? '111111' : '000000';
    for (let attempt = 0; attempt < 5; attempt++)
      await expect(
        service.confirm(id, challenge.verificationId, wrong),
      ).rejects.toThrow(attempt === 4 ? 'expired' : 'incorrect');
    const record = await prisma.phoneVerification.findUniqueOrThrow({
      where: { id: challenge.verificationId },
    });
    expect(record.attempts).toBe(5);
    await expect(
      service.confirm(id, challenge.verificationId, otp),
    ).rejects.toThrow('expired');
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id } })).phoneVerifiedAt,
    ).toBeNull();
  });

  it('rejects another user and an expired code without verifying an account', async () => {
    const id = await user();
    const other = await user();
    const challenge = await service.start(id, '08031234567');
    const otp = code();
    await expect(
      service.confirm(other, challenge.verificationId, otp),
    ).rejects.toThrow('expired');
    await prisma.phoneVerification.update({
      where: { id: challenge.verificationId },
      data: { expiresAt: new Date(0) },
    });
    await expect(
      service.confirm(id, challenge.verificationId, otp),
    ).rejects.toThrow('expired');
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id } })).phoneVerifiedAt,
    ).toBeNull();
  });

  it('invalidates the previous challenge on resend and clears verification for a new number', async () => {
    const id = await user();
    const first = await service.start(id, '08031234567');
    const oldCode = code();
    await service.confirm(id, first.verificationId, oldCode);
    await prisma.phoneVerification.update({
      where: { id: first.verificationId },
      data: { createdAt: new Date(Date.now() - 61_000) },
    });
    const next = await service.start(id, '08031234568');
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id } })).phoneVerifiedAt,
    ).toBeNull();
    await expect(
      service.confirm(id, first.verificationId, oldCode),
    ).rejects.toThrow('expired');
    await expect(
      service.confirm(id, next.verificationId, code()),
    ).resolves.toMatchObject({ phone: '+2348031234568' });
  });

  it('allows only one concurrent send and one concurrent confirmation', async () => {
    const id = await user();
    const sends = await Promise.allSettled([
      service.start(id, '08031234567'),
      service.start(id, '08031234567'),
    ]);
    expect(
      sends.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      await prisma.phoneVerification.count({ where: { userId: id } }),
    ).toBe(1);
    const sent = sends.find((result) => result.status === 'fulfilled');
    if (sent?.status !== 'fulfilled')
      throw new Error('Expected one successful send.');
    const confirmations = await Promise.allSettled([
      service.confirm(id, sent.value.verificationId, code()),
      service.confirm(id, sent.value.verificationId, code()),
    ]);
    expect(
      confirmations.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
  });

  it('enforces hourly and distinct-number limits', async () => {
    const id = await user();
    await prisma.phoneVerification.createMany({
      data: Array.from({ length: 5 }, (_, index) => ({
        userId: id,
        phoneE164: '+2348031234567',
        codeHash: 'not-used',
        expiresAt: new Date(0),
        createdAt: new Date(Date.now() - 120_000 - index * 1000),
      })),
    });
    await expect(service.start(id, '08031234567')).rejects.toThrow(
      'Too many codes',
    );
    await prisma.phoneVerification.deleteMany({ where: { userId: id } });
    await prisma.phoneVerification.createMany({
      data: ['+2348031234567', '+2348031234568', '+2348031234569'].map(
        (phoneE164) => ({
          userId: id,
          phoneE164,
          codeHash: 'not-used',
          expiresAt: new Date(0),
          createdAt: new Date(Date.now() - 120_000),
        }),
      ),
    });
    await expect(service.start(id, '08031234560')).rejects.toThrow(
      'three different numbers',
    );
  });

  it('invalidates a challenge when queueing fails', async () => {
    const id = await user();
    queued.mockRejectedValueOnce(new Error('queue unavailable'));
    await expect(service.start(id, '08031234567')).rejects.toThrow(
      'temporarily unavailable',
    );
    const record = await prisma.phoneVerification.findFirstOrThrow({
      where: { userId: id },
    });
    expect(record.consumedAt).not.toBeNull();
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id } })).phoneVerifiedAt,
    ).toBeNull();
  });
});
