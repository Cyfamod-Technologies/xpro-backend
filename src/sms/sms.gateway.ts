import { ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export const SMS_GATEWAY = Symbol('SMS_GATEWAY');

export interface SmsGateway {
  readonly configured: boolean;
  sendCode(phone: string, code: string): Promise<void>;
}

export function createSmsGateway(config: ConfigService): SmsGateway {
  const provider = config.get<string>('SMS_PROVIDER')?.trim() || 'none';
  if (provider !== 'none')
    throw new Error(`SMS_PROVIDER=${provider} has no registered SMS adapter.`);

  return {
    configured: false,
    sendCode: () =>
      Promise.reject(
        new ServiceUnavailableException(
          'Phone verification is temporarily unavailable. Try again later.',
        ),
      ),
  };
}
