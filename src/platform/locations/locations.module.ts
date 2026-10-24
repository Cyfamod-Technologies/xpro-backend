import { Module } from '@nestjs/common';
import { AuditLogsModule } from '../../audit-logs/audit-logs.module';
import { PlatformModule } from '../platform.module';
import {
  LocationsController,
  AdminLocationsController,
} from './locations.controller';
import { LocationsService } from './locations.service';

@Module({
  imports: [PlatformModule, AuditLogsModule],
  controllers: [LocationsController, AdminLocationsController],
  providers: [LocationsService],
  exports: [LocationsService],
})
export class LocationsModule {}
