import { BullModule } from '@nestjs/bullmq';
import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { validateEnv } from './config/env.validation';
import { RequestContextMiddleware } from './common/request-context/request-context.middleware';
import { RequestContextModule } from './common/request-context/request-context.module';
import { AuditLogsModule } from './audit-logs/audit-logs.module';
import { AuthModule } from './auth/auth.module';
import { HealthModule } from './health/health.module';
import { JobsModule } from './jobs/jobs.module';
import { NotificationsModule } from './notifications/notifications.module';
import { OutboxModule } from './platform/outbox/outbox.module';
import { PlatformModule } from './platform/platform.module';
import { TimersModule } from './platform/timers/timers.module';
import { SettingsModule } from './platform/settings/settings.module';
import { LocationsModule } from './platform/locations/locations.module';
import { CatalogModule } from './platform/catalog/catalog.module';
import { PrismaModule } from './prisma/prisma.module';
import { RedisModule } from './redis/redis.module';
import { UsersModule } from './users/users.module';
import { XProClientGuard } from './common/guards/xpro-client.guard';
import { StaffModule } from './staff/staff.module';
import { ProvidersModule } from './providers/providers.module';
import { UploadsModule } from './uploads/uploads.module';
import { RequestsModule } from './requests/requests.module';

@Module({
  imports: [
    RequestContextModule,
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath:
        process.env.NODE_ENV === 'production' ? '.env.prod' : '.env.local',
      validate: validateEnv,
    }),
    PrismaModule,
    PlatformModule,
    OutboxModule,
    TimersModule,
    SettingsModule,
    LocationsModule,
    CatalogModule,
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 120 }]),
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: {
          host: config.get<string>('REDIS_HOST') || '127.0.0.1',
          port: config.get<number>('REDIS_PORT') || 6379,
          password: config.get<string>('REDIS_PASSWORD') || undefined,
        },
        defaultJobOptions: {
          attempts: 3,
          backoff: { type: 'exponential', delay: 5000 },
          removeOnComplete: { count: 200 },
          removeOnFail: { count: 100 },
        },
      }),
    }),
    RedisModule,
    AuthModule,
    StaffModule,
    ProvidersModule,
    UploadsModule,
    RequestsModule,
    UsersModule,
    AuditLogsModule,
    NotificationsModule,
    JobsModule,
    HealthModule,
    // UploadsModule imports optional storage infrastructure; file endpoints return 503 when disabled.
  ],
  providers: [
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
    {
      provide: APP_GUARD,
      useClass: XProClientGuard,
    },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(RequestContextMiddleware).forRoutes('*');
  }
}
