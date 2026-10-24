import { Body, Controller, Get, Headers, Param, Post, Req, Res, UseGuards, ValidationPipe } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import type { RequestUser } from '../../common/types/request-user';
import { parseEtag } from '../../platform/concurrency/etag.util';
import { AppError } from '../../platform/errors/app-error';
import { IdempotencyKey } from '../../platform/idempotency/idempotency-key.decorator';
import { AddProgressDto, AddProgressOnBehalfDto, ReviewProgressDto } from './progress.dto';
import { ProgressService } from './progress.service';

@ApiTags('Request execution') @ApiBearerAuth() @Controller('requests/:id') @UseGuards(JwtAuthGuard)
export class ProgressController {
  constructor(private readonly progress: ProgressService) {}
  @Get('updates') list(@CurrentUser() user: RequestUser, @Param('id') id: string) { return this.progress.list(user, id); }
  @Post('updates')
  async add(@CurrentUser() user: RequestUser, @Param('id') id: string, @Body(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true })) dto: AddProgressDto, @Headers('if-match') tag: string | undefined, @IdempotencyKey({ required: true }) key: string, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const version = tag ? parseEtag(tag) : null; if (version === null) throw new AppError(422, 'VALIDATION_ERROR', 'If-Match header is required.');
    const result = await this.progress.add(user.id, id, dto, version, req.originalUrl, key); res.setHeader('ETag', result.etag); return result.body;
  }
  @Post('updates/on-behalf')
  async addOnBehalf(@CurrentUser() user: RequestUser, @Param('id') id: string, @Body(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true })) dto: AddProgressOnBehalfDto, @Headers('if-match') tag: string | undefined, @IdempotencyKey() key: string | undefined, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const version = tag ? parseEtag(tag) : null; if (version === null) throw new AppError(422, 'VALIDATION_ERROR', 'If-Match header is required.');
    const result = await this.progress.addOnBehalf(user.id, id, dto, version, req.originalUrl, key); res.setHeader('ETag', result.etag); return result.body;
  }
  @Post('updates/:uid/review')
  async review(@CurrentUser() user: RequestUser, @Param('id') id: string, @Param('uid') uid: string, @Body(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true })) dto: ReviewProgressDto, @Headers('if-match') tag: string | undefined, @IdempotencyKey() key: string | undefined, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const version = tag ? parseEtag(tag) : null; if (version === null) throw new AppError(422, 'VALIDATION_ERROR', 'If-Match header is required.');
    const result = await this.progress.review(user.id, id, uid, dto, version, req.originalUrl, key); res.setHeader('ETag', result.etag); return result.body;
  }
}
