import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NotificationDispatcher } from '../notifications/notification-dispatcher';
import { NotificationsModule } from '../notifications/notifications.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { OutboxModule } from '../platform/outbox/outbox.module';
import { PlatformModule } from '../platform/platform.module';
import { TimersModule } from '../platform/timers/timers.module';
import { UploadsModule } from '../uploads/uploads.module';
import { RequestEventsModule } from '../requests/events/request-events.module';
import { Phase2OnlyGuard } from '../common/guards/phase2-only.guard';
import {
  AdminFinanceController,
  AdminPaymentsController,
  AdminTransactionsController,
  PaystackWebhookController,
  ProviderEarningsController,
  RequestPaymentsController,
} from './payments.controller';
import { GatewayInboxService } from './gateway-inbox.service';
import { PaymentsFileAccess } from './payments-file-access';
import { PAYMENT_GATEWAY, PaymentsService } from './payments.service';
import { PaystackEventsService } from './paystack-events.service';
import { FinanceService } from './finance.service';
import { RefundsService } from './refunds.service';
import { FinancialLedgerService } from './financial-ledger.service';
import { PaystackGateway } from './paystack.gateway';
import { TestPaymentGateway } from './test-payment.gateway';

@Module({
  imports: [
    PlatformModule,
    NotificationsModule,
    AuditLogsModule,
    OutboxModule,
    TimersModule,
    UploadsModule,
    RequestEventsModule,
  ],
  controllers: [
    RequestPaymentsController,
    AdminPaymentsController,
    AdminTransactionsController,
    PaystackWebhookController,
    AdminFinanceController,
    ProviderEarningsController,
  ],
  providers: [
    {
      provide: PAYMENT_GATEWAY,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        if (config.get<string>('PAYMENT_GATEWAY') === 'test') {
          if (config.get<string>('NODE_ENV') === 'production')
            throw new Error(
              'The test payment gateway cannot run in production.',
            );
          return new TestPaymentGateway();
        }
        return new PaystackGateway(config);
      },
    },
    PaymentsService,
    GatewayInboxService,
    PaystackEventsService,
    PaymentsFileAccess,
    FinanceService,
    RefundsService,
    FinancialLedgerService,
    NotificationDispatcher,
    Phase2OnlyGuard,
  ],
  exports: [
    PaymentsService,
    FinanceService,
    RefundsService,
    FinancialLedgerService,
  ],
})
export class PaymentsModule {}
