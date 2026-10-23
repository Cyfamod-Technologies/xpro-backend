import { Module } from '@nestjs/common';
import { JobsModule } from '../../jobs/jobs.module';
import { NotificationsModule } from '../../notifications/notifications.module';
import { OutboxProcessor } from './outbox.processor';
import { OutboxService } from './outbox.service';

@Module({
  imports: [JobsModule, NotificationsModule],
  providers: [OutboxService, OutboxProcessor],
  exports: [OutboxService],
})
export class OutboxModule {}
