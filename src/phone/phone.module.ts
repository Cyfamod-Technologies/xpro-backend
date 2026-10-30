import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { JobsModule } from '../jobs/jobs.module';
import { PrismaModule } from '../prisma/prisma.module';
import { SmsModule } from '../sms/sms.module';
import { PhoneController } from './phone.controller';
import { PhoneVerificationService } from './phone-verification.service';

@Module({
  imports: [ConfigModule, PrismaModule, AuditLogsModule, JobsModule, SmsModule],
  controllers: [PhoneController],
  providers: [PhoneVerificationService],
})
export class PhoneModule {}
