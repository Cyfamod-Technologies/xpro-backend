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
import { SchedulesController } from './scheduling/schedules.controller';
import { SchedulesService } from './scheduling/schedules.service';
import { HoldsController } from './execution/holds.controller';
import { HoldsService } from './execution/holds.service';
import { NoShowController } from './execution/noshow.controller';
import { NoShowService } from './execution/noshow.service';
import { SchedulingTimerHandlers } from './scheduling/scheduling-timer-handlers';
import { CompletionController } from './completion/completion.controller';
import { CompletionService } from './completion/completion.service';
import { CompletionTimerHandlers } from './completion/completion-timer-handlers';
import { ProgressController } from './execution/progress.controller';
import { ProgressService } from './execution/progress.service';
import { ClosureController } from './completion/closure.controller';
import { ClosureService } from './completion/closure.service';
import { IssuesController } from './completion/issues.controller';
import { IssuesService } from './completion/issues.service';
import { CancellationController } from './cancellation/cancellation.controller';
import { CancellationService } from './cancellation/cancellation.service';
import { ExecutionTimerHandlers } from './execution/execution-timer-handlers';

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
  controllers: [
    RequestsController,
    DispatchController,
    PricingController,
    SchedulesController,
    HoldsController,
    NoShowController,
    CompletionController,
    ProgressController,
    ClosureController,
    IssuesController,
    CancellationController,
  ],
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
    SchedulesService,
    HoldsService,
    NoShowService,
    SchedulingTimerHandlers,
    CompletionService,
    CompletionTimerHandlers,
    ProgressService,
    ClosureService,
    IssuesService,
    CancellationService,
    ExecutionTimerHandlers,
    ApprovalsHooks,
    NotificationDispatcher,
    RequestFileAccess,
    T6TimerHandlers,
  ],
  exports: [RequestCommandRunner, RequestSnapshotLoader, ProviderStandingHooks],
})
export class RequestsModule {}
