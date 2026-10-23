import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module';
import { NotificationDispatcher } from '../notifications/notification-dispatcher';
import { OutboxModule } from '../platform/outbox/outbox.module';
import { PlatformModule } from '../platform/platform.module';
import { SettingsModule } from '../platform/settings/settings.module';
import { TimersModule } from '../platform/timers/timers.module';
import { UploadsModule } from '../uploads/uploads.module';
import { RequestCommandRunner } from './command-runner';
import { RequestFileAccess } from './request-file-access';
import { RequestsController } from './requests.controller';
import { RequestsReadService } from './requests-read.service';
import { RequestSnapshotLoader } from './snapshot.loader';
import { IntakeService } from './intake.service';
import { ApprovalsHooks } from './approvals.hooks';
import { T6TimerHandlers } from './t6-timer-handlers';
import { OwnershipService } from './ownership.service';
import { MessagesService } from './messages.service';

@Module({
  imports: [PlatformModule, SettingsModule, NotificationsModule, TimersModule, OutboxModule, UploadsModule],
  controllers: [RequestsController],
  providers: [RequestSnapshotLoader, RequestCommandRunner, RequestsReadService, IntakeService, OwnershipService, MessagesService, ApprovalsHooks, NotificationDispatcher, RequestFileAccess, T6TimerHandlers],
  exports: [RequestCommandRunner, RequestSnapshotLoader],
})
export class RequestsModule {}
