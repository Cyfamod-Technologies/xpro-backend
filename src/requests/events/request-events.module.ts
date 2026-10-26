import { Module } from '@nestjs/common';
import { NotificationsModule } from '../../notifications/notifications.module';
import { NotificationDispatcher } from '../../notifications/notification-dispatcher';
import { OutboxModule } from '../../platform/outbox/outbox.module';
import { PlatformModule } from '../../platform/platform.module';
import { SettingsModule } from '../../platform/settings/settings.module';
import { TimersModule } from '../../platform/timers/timers.module';
import { ApprovalsHooks } from '../approvals.hooks';
import { RequestCommandRunner } from '../command-runner';
import { RequestSnapshotLoader } from '../snapshot.loader';
import { RequestEventsService } from './request-events.service';

/**
 * Owns the command runner and the domain-event service so payments and
 * providers can move a request without importing `RequestsModule`, which
 * itself imports `PaymentsModule`.
 */
@Module({
  imports: [
    PlatformModule,
    SettingsModule,
    NotificationsModule,
    TimersModule,
    OutboxModule,
  ],
  providers: [
    RequestSnapshotLoader,
    ApprovalsHooks,
    NotificationDispatcher,
    RequestCommandRunner,
    RequestEventsService,
  ],
  exports: [
    RequestSnapshotLoader,
    ApprovalsHooks,
    NotificationDispatcher,
    RequestCommandRunner,
    RequestEventsService,
  ],
})
export class RequestEventsModule {}
