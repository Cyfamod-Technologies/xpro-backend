import { Module } from '@nestjs/common';
import { JobsModule } from '../jobs/jobs.module';
import { RedisModule } from '../redis/redis.module';
import { InboxController } from './inbox.controller';
import { InboxService } from './inbox.service';
import { NotificationsService } from './notifications.service';
import { StaffRoutingService } from './staff-routing.service';
import { Phase2OnlyGuard } from '../common/guards/phase2-only.guard';

@Module({
  imports: [JobsModule, RedisModule],
  controllers: [InboxController],
  providers: [
    NotificationsService,
    InboxService,
    StaffRoutingService,
    Phase2OnlyGuard,
  ],
  exports: [NotificationsService, InboxService, StaffRoutingService],
})
export class NotificationsModule {}
