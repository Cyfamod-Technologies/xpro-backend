import { Module } from '@nestjs/common';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { PlatformModule } from '../platform/platform.module';
import { SettingsModule } from '../platform/settings/settings.module';
import { ProvidersModule } from '../providers/providers.module';
import { UploadsModule } from '../uploads/uploads.module';
import { V1Controller } from './v1.controller';
import { V1Service } from './v1.service';

@Module({
  imports: [
    PlatformModule,
    SettingsModule,
    ProvidersModule,
    UploadsModule,
    AuditLogsModule,
  ],
  controllers: [V1Controller],
  providers: [V1Service],
})
export class V1Module {}
