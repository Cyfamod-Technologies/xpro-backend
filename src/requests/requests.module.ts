import { Module } from '@nestjs/common';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { OutboxModule } from '../platform/outbox/outbox.module';
import { PlatformModule } from '../platform/platform.module';
import { SettingsModule } from '../platform/settings/settings.module';
import { TimersModule } from '../platform/timers/timers.module';
import { UploadsModule } from '../uploads/uploads.module';
import { RequestEventsModule } from './events/request-events.module';
import { RequestFileAccess } from './request-file-access';
import { PublicRequestConfigController } from './public-request-config.controller';
import { RequestsReadService } from './requests-read.service';
import { RequestListLoader } from './request-list.loader';
import { IntakeService } from './intake.service';
import { RequestGroupsService } from './request-groups.service';
import { CustomerRequestLimitController } from './customer-request-limit.controller';
import { CustomerRequestLimitService } from './customer-request-limit.service';
import { T6TimerHandlers } from './t6-timer-handlers';
import { OwnershipService } from './ownership.service';
import { MessagesService } from './messages.service';
import { ConversationsService } from './conversations.service';
import { DispatchService } from './dispatch/dispatch.service';
import { ProviderDispatchLoader } from './dispatch/provider-dispatch.loader';
import { PricingService } from './pricing/pricing.service';
import { DispatchTimerHandlers } from './dispatch/dispatch-timer-handlers';
import { T9TimerHandlers } from './t9-timer-handlers';
import { PaymentsModule } from '../payments/payments.module';
import { ProvidersModule } from '../providers/providers.module';
import { PricingTimerHandlers } from './pricing/pricing-timer-handlers';
import { SchedulesService } from './scheduling/schedules.service';
import { HoldsService } from './execution/holds.service';
import { NoShowService } from './execution/noshow.service';
import { SchedulingTimerHandlers } from './scheduling/scheduling-timer-handlers';
import { CompletionService } from './completion/completion.service';
import { CompletionTimerHandlers } from './completion/completion-timer-handlers';
import { ProgressService } from './execution/progress.service';
import { ClosureService } from './completion/closure.service';
import { IssuesService } from './completion/issues.service';
import { CancellationService } from './cancellation/cancellation.service';
import { CancellationTimerHandlers } from './cancellation/cancellation-timer-handlers';
import { EscalationsService } from '../approvals/escalations.service';
import { ExecutionTimerHandlers } from './execution/execution-timer-handlers';

@Module({
  imports: [
    PlatformModule,
    SettingsModule,
    AuditLogsModule,
    NotificationsModule,
    TimersModule,
    OutboxModule,
    UploadsModule,
    PaymentsModule,
    ProvidersModule,
    RequestEventsModule,
  ],
  controllers: [PublicRequestConfigController, CustomerRequestLimitController],
  providers: [
    RequestListLoader,
    RequestsReadService,
    IntakeService,
    RequestGroupsService,
    CustomerRequestLimitService,
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
  exports: [
    RequestEventsModule,
    RequestListLoader,
    RequestsReadService,
    IntakeService,
    RequestGroupsService,
    CustomerRequestLimitService,
    OwnershipService,
    MessagesService,
    ConversationsService,
    DispatchService,
    ProviderDispatchLoader,
    PricingService,
    SchedulesService,
    HoldsService,
    NoShowService,
    CompletionService,
    ProgressService,
    ClosureService,
    IssuesService,
    CancellationService,
    EscalationsService,
    RequestFileAccess,
  ],
})
export class RequestsModule {}
