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
import { IdempotencyKey } from '../../platform/idempotency/idempotency-key.decorator';
import {
  ProposeScheduleDto,
  RequestScheduleChangeDto,
  RespondScheduleDto,
} from './schedules.dto';
import { SchedulesService } from './schedules.service';

@ApiTags('Request scheduling')
@ApiBearerAuth()
@Controller('requests/:id/schedules')
@UseGuards(JwtAuthGuard)
export class SchedulesController {
  constructor(private readonly schedules: SchedulesService) {}

  @Post()
  async propose(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    )
    dto: ProposeScheduleDto,
    @IfMatch() version: number | undefined,
    @IdempotencyKey() key: string | undefined,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.schedules.propose(
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

  @Post(':sid/respond')
  async respond(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Param('sid') sid: string,
    @Body(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    )
    dto: RespondScheduleDto,
    @IfMatch() version: number | undefined,
    @IdempotencyKey() key: string | undefined,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.schedules.respond(
      user,
      id,
      sid,
      dto,
      version,
      req.originalUrl,
      key,
    );
    res.setHeader('ETag', result.etag);
    return result.body;
  }

  @Post(':sid/change-requests')
  async requestChange(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Param('sid') sid: string,
    @Body(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    )
    dto: RequestScheduleChangeDto,
    @IfMatch() version: number | undefined,
    @IdempotencyKey() key: string | undefined,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.schedules.requestChange(
      user,
      id,
      sid,
      dto,
      version,
      req.originalUrl,
      key,
    );
    res.setHeader('ETag', result.etag);
    return result.body;
  }
}
