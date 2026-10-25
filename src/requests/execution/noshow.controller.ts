import {
  Body,
  Controller,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
  ValidationPipe,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import type { RequestUser } from '../../common/types/request-user';
import { IfMatch } from '../../platform/concurrency/if-match.decorator';
import { AppError } from '../../platform/errors/app-error';
import { IdempotencyKey } from '../../platform/idempotency/idempotency-key.decorator';
import { DecideNoShowDto, RecordNoShowDto } from './noshow.dto';
import { NoShowService } from './noshow.service';

@ApiTags('Request no-shows')
@ApiBearerAuth()
@Controller('requests/:id/noshow')
@UseGuards(JwtAuthGuard)
export class NoShowController {
  constructor(private readonly noshows: NoShowService) {}
  @Post()
  async record(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    )
    dto: RecordNoShowDto,
    @IfMatch() version: number | undefined,
    @IdempotencyKey() key: string | undefined,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.noshows.record(
      user.id,
      id,
      dto,
      version,
      req.originalUrl,
      key,
    );
    res.setHeader('ETag', result.etag);
    return result.body;
  }
  @Post(':nid/decision')
  async decide(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Param('nid') nid: string,
    @Body(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    )
    dto: DecideNoShowDto,
    @IfMatch() version: number | undefined,
    @IdempotencyKey() key: string | undefined,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (!dto.outcome)
      throw new AppError(422, 'VALIDATION_ERROR', 'Choose confirm or dismiss.');
    const result = await this.noshows.decide(
      user.id,
      id,
      nid,
      dto.outcome,
      dto,
      version,
      req.originalUrl,
      key,
    );
    res.setHeader('ETag', result.etag);
    return result.body;
  }
  @Post(':nid/correction')
  async correct(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Param('nid') nid: string,
    @Body(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    )
    dto: DecideNoShowDto,
    @IfMatch() version: number | undefined,
    @IdempotencyKey() key: string | undefined,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.noshows.correct(
      user.id,
      id,
      nid,
      dto,
      version,
      req.originalUrl,
      key,
    );
    res.setHeader('ETag', result.etag);
    return result.body;
  }
}
