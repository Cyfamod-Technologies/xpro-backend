import { Body, Controller, Headers, Param, Post, Req, Res, UseGuards, ValidationPipe } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import type { RequestUser } from '../../common/types/request-user';
import { parseEtag } from '../../platform/concurrency/etag.util';
import { AppError } from '../../platform/errors/app-error';
import { IdempotencyKey } from '../../platform/idempotency/idempotency-key.decorator';
import { CancellationService } from './cancellation.service';
import { DecideCancellationDto, RequestCancellationDto, WithdrawCancellationDto } from './cancellation.dto';

@ApiTags('Request cancellation') @ApiBearerAuth() @Controller('requests/:id') @UseGuards(JwtAuthGuard)
export class CancellationController {
  constructor(private readonly cancellations: CancellationService) {}
  @Post('cancellations')
  async request(@CurrentUser() user: RequestUser, @Param('id') id: string, @Body(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true })) dto: RequestCancellationDto, @Headers('if-match') tag: string | undefined, @IdempotencyKey() key: string | undefined, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const version = tag ? parseEtag(tag) : null; if (version === null) throw new AppError(422, 'VALIDATION_ERROR', 'If-Match header is required.');
    const result = await this.cancellations.request(user, id, dto, version, req.originalUrl, key); res.setHeader('ETag', result.etag); return result.body;
  }
  @Post('cancellations/:cid/withdraw')
  async withdraw(@CurrentUser() user: RequestUser, @Param('id') id: string, @Param('cid') cid: string, @Body(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true })) dto: WithdrawCancellationDto, @Headers('if-match') tag: string | undefined, @IdempotencyKey() key: string | undefined, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const version = tag ? parseEtag(tag) : null; if (version === null) throw new AppError(422, 'VALIDATION_ERROR', 'If-Match header is required.');
    const result = await this.cancellations.withdraw(user, id, cid, dto, version, req.originalUrl, key); res.setHeader('ETag', result.etag); return result.body;
  }
  @Post('cancellation/decide')
  async decide(@CurrentUser() user: RequestUser, @Param('id') id: string, @Body(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true })) dto: DecideCancellationDto, @Headers('if-match') tag: string | undefined, @IdempotencyKey() key: string | undefined, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const version = tag ? parseEtag(tag) : null; if (version === null) throw new AppError(422, 'VALIDATION_ERROR', 'If-Match header is required.');
    const result = await this.cancellations.decide(user.id, id, dto, version, req.originalUrl, key); res.setHeader('ETag', result.etag); return result.body;
  }
}
