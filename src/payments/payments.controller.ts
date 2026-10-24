import { Body, Controller, Get, Headers, HttpCode, HttpStatus, Param, Post, Query, Req, UseGuards, ValidationPipe } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import type { RequestUser } from '../common/types/request-user';
import { IdempotencyKey } from '../platform/idempotency/idempotency-key.decorator';
import { AppError } from '../platform/errors/app-error';
import { PaymentsService } from './payments.service';
import { FinanceService } from './finance.service';
import { FinanceNoteDto, InitiatePaymentDto, OfflinePaymentDto, OfflineTransferDto, PaymentNoteDto, PayoutDecisionDto, PayoutHoldDto, PayoutSecondApprovalDto, PayoutTransferDto, RefundDecisionDto, RejectPaymentDto } from './payments.dto';

@ApiTags('Payments')
@ApiBearerAuth()
@Controller('requests/:id/payments')
@UseGuards(JwtAuthGuard)
export class RequestPaymentsController {
  constructor(private readonly payments: PaymentsService) {}
  @Get() get(@CurrentUser() user: RequestUser, @Param('id') id: string) { return this.payments.getRequestPayments(user, id); }
  @Post() @HttpCode(HttpStatus.ACCEPTED)
  initiate(@CurrentUser() user: RequestUser, @Param('id') id: string, @Body(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true })) _dto: InitiatePaymentDto, @IdempotencyKey({ required: true }) key: string, @Req() req: Request) {
    return this.payments.initiate(user, id, key, req.originalUrl);
  }
}

@ApiTags('Payments')
@ApiBearerAuth()
@Controller('admin')
@UseGuards(JwtAuthGuard)
export class AdminPaymentsController {
  constructor(private readonly payments: PaymentsService) {}
  @Post('requests/:id/payments/offline') @HttpCode(HttpStatus.CREATED)
  async record(@CurrentUser() user: RequestUser, @Param('id') id: string, @Body(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true })) dto: OfflinePaymentDto) {
    const row = await this.payments.recordOffline(user.id, id, dto);
    return { ...row, amount: Number(row.amount) };
  }
  @Post('payments/:id/reconcile') @HttpCode(HttpStatus.OK)
  async reconcile(@CurrentUser() user: RequestUser, @Param('id') id: string, @Body(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true })) dto: PaymentNoteDto) {
    const row = await this.payments.reconcile(user.id, id, dto.note);
    return { ...row, amount: Number(row.amount) };
  }
  @Post('payments/:id/reject') @HttpCode(HttpStatus.OK)
  async reject(@CurrentUser() user: RequestUser, @Param('id') id: string, @Body(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true })) dto: RejectPaymentDto) {
    const row = await this.payments.rejectOffline(user.id, id, dto.reason);
    return { ...row, amount: Number(row.amount) };
  }
}

@ApiTags('Paystack webhooks')
@Controller('webhooks/paystack')
export class PaystackWebhookController {
  constructor(private readonly payments: PaymentsService) {}
  @Post() @HttpCode(HttpStatus.OK)
  receive(@Headers('x-paystack-signature') signature: string | undefined, @Req() req: Request & { rawBody?: Buffer }) {
    return this.payments.handleWebhook(req.rawBody ?? Buffer.alloc(0), signature, req.body);
  }
}

@ApiTags('Finance')
@ApiBearerAuth()
@Controller('admin')
@UseGuards(JwtAuthGuard)
export class AdminFinanceController {
  constructor(private readonly finance: FinanceService) {}
  @Get('refunds') refunds(@CurrentUser() user: RequestUser, @Query('page') page?: string) { return this.finance.refunds(user.id, Math.max(1, Number(page) || 1)); }
  @Post('refunds/:id/decide') decideRefund(@CurrentUser() user: RequestUser, @Param('id') id: string, @Body(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true })) dto: RefundDecisionDto) { return this.finance.decideRefund(user.id, id, dto); }
  @Post('refunds/:id/second-approve') secondApproveRefund(@CurrentUser() user: RequestUser, @Param('id') id: string, @Body(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true })) dto: RefundDecisionDto) { return this.finance.secondApproveRefund(user.id, id, dto); }
  @Post('refunds/:id/transfer') transferRefund(@CurrentUser() user: RequestUser, @Param('id') id: string, @Body(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true })) dto: OfflineTransferDto) { return this.finance.recordRefundTransfer(user.id, id, dto); }
  @Post('refunds/:id/reconcile') reconcileRefund(@CurrentUser() user: RequestUser, @Param('id') id: string, @Body(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true })) dto: FinanceNoteDto) { return this.finance.reconcileRefund(user.id, id, dto.note); }
  @Get('payouts') payouts(@CurrentUser() user: RequestUser, @Query('page') page?: string) { return this.finance.payouts(user.id, Math.max(1, Number(page) || 1)); }
  @Post('payouts/:id/approve') approvePayout(@CurrentUser() user: RequestUser, @Param('id') id: string, @Body(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true })) dto: PayoutDecisionDto) { return this.finance.approvePayout(user.id, id, dto.note); }
  @Post('payouts/:id/second-approve') secondApprovePayout(@CurrentUser() user: RequestUser, @Param('id') id: string, @Body(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true })) dto: PayoutSecondApprovalDto) { return this.finance.secondApprovePayout(user.id, id, dto.approve, dto.note); }
  @Post('payouts/:id/hold') holdPayout(@CurrentUser() user: RequestUser, @Param('id') id: string, @Body(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true })) dto: PayoutHoldDto) { return this.finance.payoutHold(user.id, id, true, dto.reason); }
  @Post('payouts/:id/release') releasePayout(@CurrentUser() user: RequestUser, @Param('id') id: string, @Body(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true })) dto: PayoutHoldDto) { return this.finance.payoutHold(user.id, id, false, dto.reason); }
  @Post('payouts/:id/transfer') transferPayout(@CurrentUser() user: RequestUser, @Param('id') id: string, @Body(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true })) dto: PayoutTransferDto) {
    if (dto.method === 'offline') {
      if (!dto.reference || !dto.proofFileId) throw new AppError(422, 'VALIDATION_ERROR', 'An offline transfer reference and proof file are required.');
      return this.finance.transferPayout(user.id, id, { method: 'offline', reference: dto.reference, proofFileId: dto.proofFileId });
    }
    return this.finance.transferPayout(user.id, id, { method: 'paystack' });
  }
  @Post('payouts/:id/reconcile') reconcilePayout(@CurrentUser() user: RequestUser, @Param('id') id: string, @Body(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true })) dto: FinanceNoteDto) { return this.finance.reconcilePayout(user.id, id, dto.note); }
}

@ApiTags('Provider earnings')
@ApiBearerAuth()
@Controller('providers/me/earnings')
@UseGuards(JwtAuthGuard)
export class ProviderEarningsController {
  constructor(private readonly finance: FinanceService) {}
  @Get() get(@CurrentUser() user: RequestUser) { return this.finance.earnings(user.id); }
}
