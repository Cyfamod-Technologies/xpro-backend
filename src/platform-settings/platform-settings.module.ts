import { Module } from '@nestjs/common';
import { PlatformModule } from '../platform/platform.module';
import { SettingsModule } from '../platform/settings/settings.module';
import { PlatformSettingsController } from './platform-settings.controller';
import { PlatformSettingsService } from './platform-settings.service';

@Module({
  imports: [PlatformModule, SettingsModule],
  controllers: [PlatformSettingsController],
  providers: [PlatformSettingsService],
})
export class PlatformSettingsModule {}
