import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NotificationsModule } from '../notifications/notifications.module';
import { OutboxModule } from '../platform/outbox/outbox.module';
import { PlatformModule } from '../platform/platform.module';
import { TimersModule } from '../platform/timers/timers.module';
import { UploadsModule } from '../uploads/uploads.module';
import { RequestEventsModule } from '../requests/events/request-events.module';
import {
  AdminFinanceController,
  AdminPaymentsController,
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
import { PaystackGateway } from './paystack.gateway';
import { TestPaymentGateway } from './test-payment.gateway';

@Module({
  imports: [
    PlatformModule,
    NotificationsModule,
    OutboxModule,
    TimersModule,
    UploadsModule,
    RequestEventsModule,
  ],
  controllers: [
    RequestPaymentsController,
    AdminPaymentsController,
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
  ],
  exports: [PaymentsService, FinanceService, RefundsService],
})
export class PaymentsModule {}
