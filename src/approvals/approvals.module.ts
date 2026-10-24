import { Module } from '@nestjs/common';
import { ApprovalsController } from './approvals.controller';
import { ApprovalsService } from './approvals.service';
import { PlatformModule } from '../platform/platform.module';
import { PrismaModule } from '../prisma/prisma.module';
import { EscalationsController } from './escalations.controller';
import { EscalationsService } from './escalations.service';
import { RequestsModule } from '../requests/requests.module';
import { ApprovalsHooks } from '../requests/approvals.hooks';
import { SettingsModule } from '../platform/settings/settings.module';

@Module({
  imports: [PlatformModule, PrismaModule, RequestsModule, SettingsModule],
  controllers: [ApprovalsController, EscalationsController],
  providers: [ApprovalsService, EscalationsService, ApprovalsHooks],
  exports: [ApprovalsService],
})
export class ApprovalsModule {}
