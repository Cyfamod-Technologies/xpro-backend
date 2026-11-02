import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
  ValidationPipe,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { Phase2OnlyGuard } from '../common/guards/phase2-only.guard';
import type { RequestUser } from '../common/types/request-user';
import { formatEtag } from '../platform/concurrency/etag.util';
import { IfMatch } from '../platform/concurrency/if-match.decorator';
import { IdempotencyKey } from '../platform/idempotency/idempotency-key.decorator';
import { AppError } from '../platform/errors/app-error';
import { PaymentsService } from './payments.service';
import { PaystackEventsService } from './paystack-events.service';
import { FinanceService } from './finance.service';
import { RefundsService } from './refunds.service';
import {
  FinanceNoteDto,
  InitiatePaymentDto,
  OfflinePaymentDto,
  OfflineTransferDto,
  PaymentNoteDto,
  PlatformTransactionsQueryDto,
  PayoutDecisionDto,
  PayoutHoldDto,
  PayoutSecondApprovalDto,
  PayoutTransferDto,
  RefundDecisionDto,
  RefundReserveFundingDto,
  RefundRequestDto,
  RejectPaymentDto,
} from './payments.dto';

/** The record's `version` is its ETag (05 §11). A replayed response may predate the column, so a missing version sends no header. */
function withEtag<T>(res: Response, result: T): T {
  const version = (result as { version?: unknown } | null)?.version;
  if (typeof version === 'number') res.setHeader('ETag', formatEtag(version));
  return result;
}

@ApiTags('Payments')
@ApiBearerAuth()
@Controller('admin/transactions')
@UseGuards(JwtAuthGuard)
export class AdminTransactionsController {
  constructor(private readonly payments: PaymentsService) {}

  @Get()
  list(
    @CurrentUser() user: RequestUser,
    @Query(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    )
    query: PlatformTransactionsQueryDto,
  ) {
    return this.payments.listPlatformTransactions(user.id, query);
  }
}

@ApiTags('Payments')
@ApiBearerAuth()
@Controller('requests/:id/payments')
@UseGuards(JwtAuthGuard)
export class RequestPaymentsController {
  constructor(private readonly payments: PaymentsService) {}
  @Get() get(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.payments.getRequestPayments(user, id);
  }
  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  initiate(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    )
    _dto: InitiatePaymentDto,
    @IdempotencyKey({ required: true }) key: string,
    @Req() req: Request,
  ) {
    return this.payments.initiate(user, id, key, req.originalUrl);
  }
}

@ApiTags('Payments')
@ApiBearerAuth()
@Controller('admin')
@UseGuards(JwtAuthGuard, Phase2OnlyGuard)
export class AdminPaymentsController {
  constructor(
    private readonly payments: PaymentsService,
    private readonly refunds: RefundsService,
  ) {}
  @Post('requests/:id/payments/offline')
  @HttpCode(HttpStatus.CREATED)
  record(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    )
    dto: OfflinePaymentDto,
  ) {
    return this.payments.recordOffline(user.id, id, dto);
  }
  @Post('payments/:id/reconcile')
  @HttpCode(HttpStatus.OK)
  reconcile(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    )
    dto: PaymentNoteDto,
  ) {
    return this.payments.reconcile(user.id, id, dto.note);
  }
  @Post('payments/:id/reject')
  @HttpCode(HttpStatus.OK)
  reject(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    )
    dto: RejectPaymentDto,
  ) {
    return this.payments.rejectOffline(user.id, id, dto.reason);
  }
  @Post('payments/:id/refunds')
  @HttpCode(HttpStatus.CREATED)
  requestRefund(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    )
    dto: RefundRequestDto,
  ) {
    return this.refunds.request(user.id, id, dto);
  }
}

@ApiTags('Paystack webhooks')
@Controller('webhooks/paystack')
@SkipThrottle()
export class PaystackWebhookController {
  constructor(private readonly events: PaystackEventsService) {}
  @Post()
  @HttpCode(HttpStatus.OK)
  receive(
    @Headers('x-paystack-signature') signature: string | undefined,
    @Req() req: Request & { rawBody?: Buffer },
  ) {
    return this.events.handleWebhook(req.rawBody ?? Buffer.alloc(0), signature);
  }
}

@ApiTags('Finance')
@ApiBearerAuth()
@Controller('admin')
@UseGuards(JwtAuthGuard, Phase2OnlyGuard)
export class AdminFinanceController {
  constructor(
    private readonly finance: FinanceService,
    private readonly refundCommands: RefundsService,
  ) {}
  @Get('refund-reserve') refundReserve(@CurrentUser() user: RequestUser) {
    return this.refundCommands.refundReserveSummary(user.id);
  }
  @Post('refund-reserve/funding')
  @HttpCode(HttpStatus.CREATED)
  recordRefundReserveFunding(
    @CurrentUser() user: RequestUser,
    @Body(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    )
    dto: RefundReserveFundingDto,
  ) {
    return this.refundCommands.recordRefundReserveFunding(user.id, dto);
  }
  @Post('refund-reserve/funding/:id/reconcile')
  async reconcileRefundReserveFunding(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    )
    dto: FinanceNoteDto,
    @IfMatch() version: number | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    return withEtag(
      res,
      await this.refundCommands.reconcileRefundReserveFunding(
        user.id,
        id,
        dto.note,
        version,
      ),
    );
  }
  @Post('refund-reserve/funding/:id/reject') async rejectRefundReserveFunding(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    )
    dto: FinanceNoteDto,
    @IfMatch() version: number | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    return withEtag(
      res,
      await this.refundCommands.rejectRefundReserveFunding(
        user.id,
        id,
        dto.note,
        version,
      ),
    );
  }
  @Get('refunds') refunds(
    @CurrentUser() user: RequestUser,
    @Query('page') page?: string,
    @Query('status') status?: string,
  ) {
    return this.refundCommands.list(user.id, {
      page: Math.max(1, Number(page) || 1),
      status,
    });
  }
  @Post('refunds/:id/decide') async decideRefund(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    )
    dto: RefundDecisionDto,
    @IfMatch() version: number | undefined,
    @IdempotencyKey({ required: true }) key: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    return withEtag(
      res,
      await this.refundCommands.decide(
        user.id,
        id,
        dto,
        { key, url: req.originalUrl },
        version,
      ),
    );
  }
  @Post('refunds/:id/second-approve') async secondApproveRefund(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    )
    dto: RefundDecisionDto,
    @IfMatch() version: number | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    return withEtag(
      res,
      await this.refundCommands.secondApprove(user.id, id, dto, version),
    );
  }
  @Post('refunds/:id/transfer') async transferRefund(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    )
    dto: OfflineTransferDto,
    @IfMatch() version: number | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    return withEtag(
      res,
      await this.refundCommands.recordTransfer(user.id, id, dto, version),
    );
  }
  @Post('refunds/:id/prepare-transfer') async prepareRefundTransfer(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @IfMatch() version: number | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    return withEtag(
      res,
      await this.refundCommands.prepareTransfer(user.id, id, version),
    );
  }
  @Post('refunds/:id/reconcile') async reconcileRefund(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    )
    dto: FinanceNoteDto,
    @IfMatch() version: number | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    return withEtag(
      res,
      await this.refundCommands.reconcile(user.id, id, dto.note, version),
    );
  }
  @Post('refunds/:id/retry')
  @HttpCode(HttpStatus.OK)
  retryRefund(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.refundCommands.retry(user.id, id);
  }
  @Get('payouts') payouts(
    @CurrentUser() user: RequestUser,
    @Query('page') page?: string,
    @Query('status') status?: string,
  ) {
    return this.finance.payouts(user.id, {
      page: Math.max(1, Number(page) || 1),
      status,
    });
  }
  @Post('payouts/:id/approve') async approvePayout(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    )
    dto: PayoutDecisionDto,
    @IfMatch() version: number | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    return withEtag(
      res,
      await this.finance.approvePayout(user.id, id, dto.note, version),
    );
  }
  @Post('payouts/:id/second-approve') async secondApprovePayout(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    )
    dto: PayoutSecondApprovalDto,
    @IfMatch() version: number | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    return withEtag(
      res,
      await this.finance.secondApprovePayout(
        user.id,
        id,
        dto.approve,
        dto.note,
        version,
      ),
    );
  }
  @Post('payouts/:id/hold') async holdPayout(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    )
    dto: PayoutHoldDto,
    @IfMatch() version: number | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    return withEtag(
      res,
      await this.finance.payoutHold(user.id, id, true, dto.reason, version),
    );
  }
  @Post('payouts/:id/release') async releasePayout(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    )
    dto: PayoutHoldDto,
    @IfMatch() version: number | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    return withEtag(
      res,
      await this.finance.payoutHold(user.id, id, false, dto.reason, version),
    );
  }
  @Post('payouts/:id/transfer') async transferPayout(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    )
    dto: PayoutTransferDto,
    @IfMatch() version: number | undefined,
    @IdempotencyKey({ required: true }) key: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const idempotency = { key, url: req.originalUrl };
    if (dto.method === 'offline') {
      if (!dto.reference || !dto.proofFileId)
        throw new AppError(
          422,
          'VALIDATION_ERROR',
          'An offline transfer reference and proof file are required.',
        );
      return withEtag(
        res,
        await this.finance.transferPayout(
          user.id,
          id,
          {
            method: 'offline',
            reference: dto.reference,
            proofFileId: dto.proofFileId,
          },
          idempotency,
          version,
        ),
      );
    }
    return withEtag(
      res,
      await this.finance.transferPayout(
        user.id,
        id,
        { method: 'paystack' },
        idempotency,
        version,
      ),
    );
  }
  @Post('payouts/:id/retry')
  @HttpCode(HttpStatus.OK)
  retryPayoutTransfer(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @IdempotencyKey({ required: true }) key: string,
    @Req() req: Request,
  ) {
    return this.finance.retryTransfer(user.id, id, {
      key,
      url: req.originalUrl,
    });
  }
  @Post('payouts/:id/reconcile') async reconcilePayout(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    )
    dto: FinanceNoteDto,
    @IfMatch() version: number | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    return withEtag(
      res,
      await this.finance.reconcilePayout(user.id, id, dto.note, version),
    );
  }
}

@ApiTags('Provider earnings')
@ApiBearerAuth()
@Controller('providers/me/earnings')
@UseGuards(JwtAuthGuard, Phase2OnlyGuard)
export class ProviderEarningsController {
  constructor(private readonly finance: FinanceService) {}
  @Get() get(@CurrentUser() user: RequestUser, @Query('page') page?: string) {
    return this.finance.earnings(user.id, Math.max(1, Number(page) || 1));
  }
}
