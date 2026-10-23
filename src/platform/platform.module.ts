import { Module } from '@nestjs/common';
import { ActorService } from './actor/actor.service';
import { IdempotencyInterceptor } from './idempotency/idempotency.interceptor';
import { IdempotencyService } from './idempotency/idempotency.service';

@Module({
  providers: [ActorService, IdempotencyService, IdempotencyInterceptor],
  exports: [ActorService, IdempotencyService, IdempotencyInterceptor],
})
export class PlatformModule {}
