import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EmailModule } from '../email/email.module';
import { PlatformModule } from '../platform/platform.module';
import { PrismaModule } from '../prisma/prisma.module';
import { QUEUE_NAMES } from './jobs.constants';
import { FailedJobsService } from './failed-jobs.service';
import { JobsService } from './jobs.service';
import { AuditLogsProcessor } from './processors/audit-logs.processor';
import { EmailProcessor } from './processors/email.processor';
import { PlatformProcessor } from './processors/platform.processor';
import { UploadsModule } from '../uploads/uploads.module';
import { SmsModule } from '../sms/sms.module';
import { SmsProcessor } from './processors/sms.processor';

@Module({
  imports: [
    ...QUEUE_NAMES.map((name) => BullModule.registerQueue({ name })),
    ConfigModule,
    SmsModule,
    EmailModule,
    PlatformModule,
    PrismaModule,
    UploadsModule,
  ],
  providers: [
    JobsService,
    FailedJobsService,
    AuditLogsProcessor,
    EmailProcessor,
    SmsProcessor,
    PlatformProcessor,
  ],
  exports: [JobsService, FailedJobsService],
})
export class JobsModule {}
