import { Module } from '@nestjs/common';
import { JobsModule } from '../../jobs/jobs.module';
import { PlatformModule } from '../platform.module';
import { DevTimersController } from './dev-timers.controller';
import { DevToolsGuard } from './dev-tools.guard';
import { TimerRegistry } from './timer-registry';
import { TimersProcessor } from './timers.processor';
import { TimersService } from './timers.service';

@Module({
  imports: [JobsModule, PlatformModule],
  controllers: [DevTimersController],
  providers: [TimersService, TimerRegistry, TimersProcessor, DevToolsGuard],
  exports: [TimersService, TimerRegistry],
})
export class TimersModule {}
