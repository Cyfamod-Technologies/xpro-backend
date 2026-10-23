import { Module } from '@nestjs/common';
import { IdempotencyInterceptor } from './idempotency/idempotency.interceptor';
import { IdempotencyService } from './idempotency/idempotency.service';

@Module({
  providers: [IdempotencyService, IdempotencyInterceptor],
  exports: [IdempotencyService, IdempotencyInterceptor],
})
export class PlatformModule {}
