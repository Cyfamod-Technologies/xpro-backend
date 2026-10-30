import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { SmsService } from './sms.service';
import { createSmsGateway, SMS_GATEWAY } from './sms.gateway';

@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: SMS_GATEWAY,
      inject: [ConfigService],
      useFactory: createSmsGateway,
    },
    SmsService,
  ],
  exports: [SmsService],
})
export class SmsModule {}
