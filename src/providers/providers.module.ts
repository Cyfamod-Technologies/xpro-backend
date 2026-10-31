import { Module } from '@nestjs/common';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { PlatformModule } from '../platform/platform.module';
import { LocationsModule } from '../platform/locations/locations.module';
import { StorageModule } from '../storage/storage.module';
import { RequestEventsModule } from '../requests/events/request-events.module';
import { Phase2OnlyGuard } from '../common/guards/phase2-only.guard';
import {
  ProvidersController,
  ProviderReviewController,
} from './providers.controller';
import { ProvidersService } from './providers.service';
import {
  FeaturedProvidersAdminController,
  FeaturedProvidersController,
} from './featured-providers.controller';
import { FeaturedProvidersService } from './featured-providers.service';

@Module({
  imports: [
    PlatformModule,
    AuditLogsModule,
    StorageModule,
    LocationsModule,
    RequestEventsModule,
  ],
  controllers: [
    ProvidersController,
    // Declared before ProviderReviewController: its `GET admin/providers/:id` would otherwise take `featured` as an id.
    FeaturedProvidersController,
    FeaturedProvidersAdminController,
    ProviderReviewController,
  ],
  providers: [ProvidersService, FeaturedProvidersService, Phase2OnlyGuard],
  exports: [ProvidersService],
})
export class ProvidersModule {}
