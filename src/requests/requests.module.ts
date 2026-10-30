import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module';
import { OutboxModule } from '../platform/outbox/outbox.module';
import { PlatformModule } from '../platform/platform.module';
import { SettingsModule } from '../platform/settings/settings.module';
import { TimersModule } from '../platform/timers/timers.module';
import { UploadsModule } from '../uploads/uploads.module';
import { RequestEventsModule } from './events/request-events.module';
import { RequestFileAccess } from './request-file-access';
import { RequestsController } from './requests.controller';
import { RequestsReadService } from './requests-read.service';
import { RequestListLoader } from './request-list.loader';
import { IntakeService } from './intake.service';
import { T6TimerHandlers } from './t6-timer-handlers';
import { OwnershipService } from './ownership.service';
import { MessagesService } from './messages.service';
import { ConversationsController } from './conversations.controller';
import { ConversationsService } from './conversations.service';
import { DispatchService } from './dispatch/dispatch.service';
import { ProviderDispatchLoader } from './dispatch/provider-dispatch.loader';
import { DispatchController } from './dispatch/dispatch.controller';
import { PricingService } from './pricing/pricing.service';
import { PricingController } from './pricing/pricing.controller';
import { DispatchTimerHandlers } from './dispatch/dispatch-timer-handlers';
import { T9TimerHandlers } from './t9-timer-handlers';
import { PaymentsModule } from '../payments/payments.module';
import { ProvidersModule } from '../providers/providers.module';
import { PricingTimerHandlers } from './pricing/pricing-timer-handlers';
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
import { CancellationTimerHandlers } from './cancellation/cancellation-timer-handlers';
import { EscalationsService } from '../approvals/escalations.service';
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
    ProvidersModule,
    RequestEventsModule,
  ],
  controllers: [
    RequestsController,
    ConversationsController,
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
    RequestListLoader,
    RequestsReadService,
    IntakeService,
    OwnershipService,
    MessagesService,
    ConversationsService,
    DispatchService,
    ProviderDispatchLoader,
    PricingService,
    DispatchTimerHandlers,
    T9TimerHandlers,
    PricingTimerHandlers,
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
    CancellationTimerHandlers,
    EscalationsService,
    ExecutionTimerHandlers,
    RequestFileAccess,
    T6TimerHandlers,
  ],
  exports: [RequestEventsModule],
})
export class RequestsModule {}
