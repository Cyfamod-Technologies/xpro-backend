import { ConfigService } from '@nestjs/config';
import { createSmsGateway } from './sms.gateway';
import { SmsService } from './sms.service';

describe('SMS gateway', () => {
  it('keeps delivery unavailable until an adapter is chosen', async () => {
    const gateway = createSmsGateway(new ConfigService({}));
    const service = new SmsService(gateway);
    expect(gateway.configured).toBe(false);
    expect(() => service.requireConfigured()).toThrow(
      'temporarily unavailable',
    );
    await expect(service.sendCode('+2348031234567', '123456')).rejects.toThrow(
      'temporarily unavailable',
    );
  });

  it('fails at startup for an unregistered provider', () => {
    expect(() =>
      createSmsGateway(new ConfigService({ SMS_PROVIDER: 'unknown' })),
    ).toThrow('no registered SMS adapter');
  });

  it('delegates delivery to the configured adapter', async () => {
    const sendCode = jest.fn().mockResolvedValue(undefined);
    const service = new SmsService({ configured: true, sendCode });
    await service.sendCode('+2348031234567', '123456');
    expect(sendCode).toHaveBeenCalledWith('+2348031234567', '123456');
  });

  it('does not expose provider errors containing credentials or verification codes', async () => {
    const service = new SmsService({
      configured: true,
      sendCode: () => Promise.reject(new Error('secret 123456')),
    });
    await expect(service.sendCode('+2348031234567', '123456')).rejects.toThrow(
      'The verification SMS could not be sent. Try again later.',
    );
  });
});
