import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { RedisModule } from '../redis/redis.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { BootstrapAdminController } from './bootstrap-admin.controller';
import {
  BOOTSTRAP_ADMIN_CONFIG,
  bootstrapAdminConfig,
} from './bootstrap-admin.config';
import { BootstrapAdminService } from './bootstrap-admin.service';
import { JwtStrategy } from './jwt.strategy';
import { RedisAuthService } from './redis-auth.service';

@Module({
  imports: [
    AuditLogsModule,
    NotificationsModule,
    RedisModule,
    ConfigModule,
    PassportModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('JWT_SECRET') || 'dev-only-secret',
        signOptions: { expiresIn: '4d' },
      }),
    }),
  ],
  controllers: [AuthController, BootstrapAdminController],
  providers: [
    AuthService,
    JwtStrategy,
    RedisAuthService,
    BootstrapAdminService,
    { provide: BOOTSTRAP_ADMIN_CONFIG, useValue: bootstrapAdminConfig },
  ],
  exports: [AuthService, RedisAuthService],
})
export class AuthModule {}
