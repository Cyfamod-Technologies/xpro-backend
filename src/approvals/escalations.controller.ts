import {
  Body,
  Controller,
  Param,
  Post,
  Get,
  Req,
  Res,
  UseGuards,
  ValidationPipe,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import type { RequestUser } from '../common/types/request-user';
import { IfMatch } from '../platform/concurrency/if-match.decorator';
import { IdempotencyKey } from '../platform/idempotency/idempotency-key.decorator';
import { EscalationsService } from './escalations.service';
import { RaiseEscalationDto, ResolveEscalationDto } from './escalations.dto';

@ApiTags('Request escalations')
@ApiBearerAuth()
@Controller('requests/:id/escalations')
@UseGuards(JwtAuthGuard)
export class EscalationsController {
  constructor(private readonly escalations: EscalationsService) {}

  @Get() list(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.escalations.list(user, id);
  }

  @Post()
  async raise(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    )
    dto: RaiseEscalationDto,
    @IfMatch() version: number | undefined,
    @IdempotencyKey() key: string | undefined,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.escalations.raise(
      user,
      id,
      dto,
      version,
      req.originalUrl,
      key,
    );
    res.setHeader('ETag', result.etag);
    return result.body;
  }

  @Post(':eid/resolve')
  async resolve(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Param('eid') eid: string,
    @Body(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    )
    dto: ResolveEscalationDto,
    @IfMatch() version: number | undefined,
    @IdempotencyKey() key: string | undefined,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.escalations.resolve(
      user,
      id,
      eid,
      dto,
      version,
      req.originalUrl,
      key,
    );
    res.setHeader('ETag', result.etag);
    return result.body;
  }
}
