import { Body, Controller, Headers, Param, Post, Req, Res, UseGuards, ValidationPipe } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import type { RequestUser } from '../../common/types/request-user';
import { parseEtag } from '../../platform/concurrency/etag.util';
import { AppError } from '../../platform/errors/app-error';
import { IdempotencyKey } from '../../platform/idempotency/idempotency-key.decorator';
import { HoldRequestDto, ReleaseHoldDto } from './holds.dto';
import { HoldsService } from './holds.service';

@ApiTags('Request execution') @ApiBearerAuth() @Controller('requests/:id') @UseGuards(JwtAuthGuard)
export class HoldsController {
  constructor(private readonly holds: HoldsService) {}

  @Post('hold')
  async hold(@CurrentUser() user: RequestUser, @Param('id') id: string, @Body(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true })) dto: HoldRequestDto, @Headers('if-match') tag: string | undefined, @IdempotencyKey() key: string | undefined, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const version = tag ? parseEtag(tag) : null; if (version === null) throw new AppError(422, 'VALIDATION_ERROR', 'If-Match header is required.');
    const result = await this.holds.hold(user.id, id, dto, version, req.originalUrl, key); res.setHeader('ETag', result.etag); return result.body;
  }

  @Post('hold/release')
  async release(@CurrentUser() user: RequestUser, @Param('id') id: string, @Body(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true })) dto: ReleaseHoldDto, @Headers('if-match') tag: string | undefined, @IdempotencyKey() key: string | undefined, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const version = tag ? parseEtag(tag) : null; if (version === null) throw new AppError(422, 'VALIDATION_ERROR', 'If-Match header is required.');
    const result = await this.holds.releaseHold(user, id, dto, version, req.originalUrl, key); res.setHeader('ETag', result.etag); return result.body;
  }
}
