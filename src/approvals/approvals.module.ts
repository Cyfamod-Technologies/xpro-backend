import { Module } from '@nestjs/common';
import { ApprovalsController } from './approvals.controller';
import { ApprovalsService } from './approvals.service';
import { ApprovalsSweeper } from './approvals-sweeper.service';
import { PlatformModule } from '../platform/platform.module';
import { PrismaModule } from '../prisma/prisma.module';
import { EscalationsController } from './escalations.controller';
import { EscalationsService } from './escalations.service';
import { RequestsModule } from '../requests/requests.module';
import { RequestEventsModule } from '../requests/events/request-events.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { SettingsModule } from '../platform/settings/settings.module';
import { TimersModule } from '../platform/timers/timers.module';
import { Phase2OnlyGuard } from '../common/guards/phase2-only.guard';

@Module({
  imports: [
    PlatformModule,
    PrismaModule,
    RequestsModule,
    RequestEventsModule,
    NotificationsModule,
    SettingsModule,
    TimersModule,
  ],
  controllers: [ApprovalsController, EscalationsController],
  providers: [
    ApprovalsService,
    ApprovalsSweeper,
    EscalationsService,
    Phase2OnlyGuard,
  ],
  exports: [ApprovalsService],
})
export class ApprovalsModule {}
