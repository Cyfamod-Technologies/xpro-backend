import { Module } from '@nestjs/common';
import { ApprovalsModule } from '../approvals/approvals.module';
import { RequestsModule } from './requests.module';
import { RequestsController } from './requests.controller';
import { RequestGroupsController } from './request-groups.controller';
import { ConversationsController } from './conversations.controller';
import { DispatchController } from './dispatch/dispatch.controller';
import { PricingController } from './pricing/pricing.controller';
import { SchedulesController } from './scheduling/schedules.controller';
import { HoldsController } from './execution/holds.controller';
import { NoShowController } from './execution/noshow.controller';
import { CompletionController } from './completion/completion.controller';
import { ProgressController } from './execution/progress.controller';
import { ClosureController } from './completion/closure.controller';
import { IssuesController } from './completion/issues.controller';
import { CancellationController } from './cancellation/cancellation.controller';

/** Phase 2 request routes are retained and mounted only when REQUEST_FLOW=phase2. */
@Module({
  imports: [RequestsModule, ApprovalsModule],
  controllers: [
    RequestsController,
    RequestGroupsController,
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
})
export class Phase2RequestRoutesModule {}
