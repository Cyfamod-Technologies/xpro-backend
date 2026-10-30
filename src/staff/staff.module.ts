import { Module } from '@nestjs/common';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { AuthModule } from '../auth/auth.module';
import { PlatformModule } from '../platform/platform.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { RedisModule } from '../redis/redis.module';
import { RequestEventsModule } from '../requests/events/request-events.module';
import {
  StaffController,
  StaffInviteController,
  StaffMfaEnrollmentController,
  StaffSelfLeaveController,
} from './staff.controller';
import { StaffHandoverService } from './staff-handover.service';
import { StaffService } from './staff.service';

@Module({
  imports: [
    PlatformModule,
    AuthModule,
    AuditLogsModule,
    NotificationsModule,
    RedisModule,
    RequestEventsModule,
  ],
  controllers: [
    StaffController,
    StaffInviteController,
    StaffMfaEnrollmentController,
    StaffSelfLeaveController,
  ],
  providers: [StaffService, StaffHandoverService],
})
export class StaffModule {}
