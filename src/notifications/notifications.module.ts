import { Module } from '@nestjs/common';
import { JobsModule } from '../jobs/jobs.module';
import { RedisModule } from '../redis/redis.module';
import { NotificationsService } from './notifications.service';

@Module({
  imports: [JobsModule, RedisModule],
  providers: [NotificationsService],
  exports: [NotificationsService],
})
export class NotificationsModule {}
