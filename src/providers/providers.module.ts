import { Module } from '@nestjs/common';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { StorageModule } from '../storage/storage.module';
import {
  ProvidersController,
  ProviderReviewController,
} from './providers.controller';
import { ProvidersService } from './providers.service';

@Module({
  imports: [AuditLogsModule, StorageModule],
  controllers: [ProvidersController, ProviderReviewController],
  providers: [ProvidersService],
})
export class ProvidersModule {}
