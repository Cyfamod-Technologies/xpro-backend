import { Module } from '@nestjs/common';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { PlatformModule } from '../platform/platform.module';
import { LocationsModule } from '../platform/locations/locations.module';
import { StorageModule } from '../storage/storage.module';
import { RequestsModule } from '../requests/requests.module';
import {
  ProvidersController,
  ProviderReviewController,
} from './providers.controller';
import { ProvidersService } from './providers.service';

@Module({
  imports: [
    PlatformModule,
    AuditLogsModule,
    StorageModule,
    LocationsModule,
    RequestsModule,
  ],
  controllers: [ProvidersController, ProviderReviewController],
  providers: [ProvidersService],
})
export class ProvidersModule {}
