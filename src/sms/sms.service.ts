import {
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { SMS_GATEWAY, type SmsGateway } from './sms.gateway';

@Injectable()
export class SmsService {
  constructor(@Inject(SMS_GATEWAY) private readonly gateway: SmsGateway) {}

  requireConfigured() {
    if (!this.gateway.configured)
      throw new ServiceUnavailableException(
        'Phone verification is temporarily unavailable. Try again later.',
      );
  }

  async sendCode(phone: string, code: string) {
    this.requireConfigured();
    try {
      await this.gateway.sendCode(phone, code);
    } catch {
      // Gateway errors may contain credentials, phone numbers or codes.
      throw new ServiceUnavailableException(
        'The verification SMS could not be sent. Try again later.',
      );
    }
  }
}
