import { Module } from '@nestjs/common';
import { AuditLogsModule } from '../../audit-logs/audit-logs.module';
import { PlatformModule } from '../platform.module';
import { SettingsModule } from '../settings/settings.module';
import { CatalogAdminController } from './catalog-admin.controller';
import { CatalogQuestionService } from './catalog-question.service';
import { CatalogController } from './catalog.controller';
import { CatalogService } from './catalog.service';

@Module({
  imports: [PlatformModule, AuditLogsModule, SettingsModule],
  controllers: [CatalogController, CatalogAdminController],
  providers: [CatalogService, CatalogQuestionService],
  exports: [CatalogService],
})
export class CatalogModule {}
