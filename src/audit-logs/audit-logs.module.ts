import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { AuditLogsService } from './audit-logs.service';

@Module({
  imports: [BullModule.registerQueue({ name: 'audit-logs' })],
  providers: [AuditLogsService],
  exports: [AuditLogsService],
})
export class AuditLogsModule {}
