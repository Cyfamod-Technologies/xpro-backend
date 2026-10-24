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
import { DispatchService } from './dispatch/dispatch.service';
import { ProviderDispatchLoader } from './dispatch/provider-dispatch.loader';
import { DispatchController } from './dispatch/dispatch.controller';
import { PricingService } from './pricing/pricing.service';
import { PricingController } from './pricing/pricing.controller';
import { DispatchTimerHandlers } from './dispatch/dispatch-timer-handlers';
import { T9TimerHandlers } from './t9-timer-handlers';
import { PaymentsModule } from '../payments/payments.module';
import { PricingTimerHandlers } from './pricing/pricing-timer-handlers';
import { ProviderStandingHooks } from './dispatch/provider-standing.hooks';

@Module({
  imports: [
    PlatformModule,
    SettingsModule,
    NotificationsModule,
    TimersModule,
    OutboxModule,
    UploadsModule,
    PaymentsModule,
  ],
  controllers: [RequestsController, DispatchController, PricingController],
  providers: [
    RequestSnapshotLoader,
    RequestCommandRunner,
    RequestsReadService,
    IntakeService,
    OwnershipService,
    MessagesService,
    DispatchService,
    ProviderDispatchLoader,
    PricingService,
    DispatchTimerHandlers,
    T9TimerHandlers,
    PricingTimerHandlers,
    ProviderStandingHooks,
    ApprovalsHooks,
    NotificationDispatcher,
    RequestFileAccess,
    T6TimerHandlers,
  ],
  exports: [RequestCommandRunner, RequestSnapshotLoader, ProviderStandingHooks],
})
export class RequestsModule {}
