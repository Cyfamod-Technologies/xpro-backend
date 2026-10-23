import { Module } from '@nestjs/common';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { AuthModule } from '../auth/auth.module';
import { PlatformModule } from '../platform/platform.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { RedisModule } from '../redis/redis.module';
import {
  StaffController,
  StaffInviteController,
  StaffMfaEnrollmentController,
} from './staff.controller';
import { StaffService } from './staff.service';

@Module({
  imports: [
    PlatformModule,
    AuthModule,
    AuditLogsModule,
    NotificationsModule,
    RedisModule,
  ],
  controllers: [
    StaffController,
    StaffInviteController,
    StaffMfaEnrollmentController,
  ],
  providers: [StaffService],
})
export class StaffModule {}
