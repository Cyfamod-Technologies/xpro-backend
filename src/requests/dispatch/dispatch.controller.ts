import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
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
import { IdempotencyKey } from '../../platform/idempotency/idempotency-key.decorator';
import { parseEtag } from '../../platform/concurrency/etag.util';
import { AppError } from '../../platform/errors/app-error';
import { DispatchService } from './dispatch.service';
import {
  AutoAssignDto,
  DispatchModeDto,
  OfferDto,
  AssignmentRespondDto,
  AssignmentReviewDto,
  AssignmentNoteDto,
  ShareDetailsDto,
} from './dispatch.dto';

@ApiTags('Dispatch')
@ApiBearerAuth()
@Controller('requests/:id')
@UseGuards(JwtAuthGuard)
export class DispatchController {
  constructor(private readonly dispatch: DispatchService) {}

  @Put('dispatch/mode')
  @HttpCode(HttpStatus.OK)
  async setMode(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    )
    dto: DispatchModeDto,
    @Headers('if-match') ifMatch: string | undefined,
    @IdempotencyKey() key: string | undefined,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const version = ifMatch ? parseEtag(ifMatch) : null;
    if (version === null)
      throw new AppError(
        422,
        'VALIDATION_ERROR',
        'If-Match header is required.',
      );
    const result = await this.dispatch.setMode(
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

  @Post('dispatch/runs')
  @HttpCode(HttpStatus.OK)
  rankingRun(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.dispatch.rankingRun(user.id, id);
  }

  @Post('dispatch/auto')
  @HttpCode(HttpStatus.OK)
  async autoAssign(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    )
    dto: AutoAssignDto,
    @Headers('if-match') ifMatch: string | undefined,
    @IdempotencyKey() key: string | undefined,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const version = ifMatch ? parseEtag(ifMatch) : null;
    if (version === null)
      throw new AppError(
        422,
        'VALIDATION_ERROR',
        'If-Match header is required.',
      );
    const result = await this.dispatch.autoAssign(
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

  @Post('assignments')
  @HttpCode(HttpStatus.CREATED)
  async offer(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    )
    dto: OfferDto,
    @Headers('if-match') ifMatch: string | undefined,
    @IdempotencyKey() key: string | undefined,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const version = ifMatch ? parseEtag(ifMatch) : null;
    if (version === null)
      throw new AppError(
        422,
        'VALIDATION_ERROR',
        'If-Match header is required.',
      );
    const result = await this.dispatch.offer(
      user.id,
      id,
      dto,
      version,
      req.originalUrl,
      key,
    );
    res.status(result.status).setHeader('ETag', result.etag);
    return result.body;
  }

  @Post('assignments/:aid/respond')
  @HttpCode(HttpStatus.OK)
  async respond(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Param('aid') aid: string,
    @Body(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    )
    dto: AssignmentRespondDto,
    @Headers('if-match') ifMatch: string | undefined,
    @IdempotencyKey() key: string | undefined,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const version = ifMatch ? parseEtag(ifMatch) : null;
    if (version === null)
      throw new AppError(
        422,
        'VALIDATION_ERROR',
        'If-Match header is required.',
      );
    const result = await this.dispatch.respond(
      user.id,
      id,
      aid,
      dto,
      version,
      req.originalUrl,
      key,
    );
    res.setHeader('ETag', result.etag);
    return result.body;
  }

  @Post('assignments/:aid/review')
  @HttpCode(HttpStatus.OK)
  async review(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Param('aid') aid: string,
    @Body(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    )
    dto: AssignmentReviewDto,
    @Headers('if-match') ifMatch: string | undefined,
    @IdempotencyKey() key: string | undefined,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const version = ifMatch ? parseEtag(ifMatch) : null;
    if (version === null)
      throw new AppError(
        422,
        'VALIDATION_ERROR',
        'If-Match header is required.',
      );
    const result = await this.dispatch.review(
      user.id,
      id,
      aid,
      dto,
      version,
      req.originalUrl,
      key,
    );
    res.setHeader('ETag', result.etag);
    return result.body;
  }

  @Post('assignments/:aid/withdraw')
  @HttpCode(HttpStatus.OK)
  async withdraw(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Param('aid') aid: string,
    @Body(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    )
    dto: AssignmentNoteDto,
    @Headers('if-match') ifMatch: string | undefined,
    @IdempotencyKey() key: string | undefined,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const version = ifMatch ? parseEtag(ifMatch) : null;
    if (version === null)
      throw new AppError(
        422,
        'VALIDATION_ERROR',
        'If-Match header is required.',
      );
    const result = await this.dispatch.withdraw(
      user.id,
      id,
      aid,
      dto.note,
      version,
      req.originalUrl,
      key,
    );
    res.setHeader('ETag', result.etag);
    return result.body;
  }

  @Post('assignments/:aid/replace')
  @HttpCode(HttpStatus.OK)
  async replace(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Param('aid') aid: string,
    @Body(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    )
    dto: AssignmentNoteDto,
    @Headers('if-match') ifMatch: string | undefined,
    @IdempotencyKey() key: string | undefined,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const version = ifMatch ? parseEtag(ifMatch) : null;
    if (version === null)
      throw new AppError(
        422,
        'VALIDATION_ERROR',
        'If-Match header is required.',
      );
    const result = await this.dispatch.replace(
      user.id,
      id,
      aid,
      dto,
      version,
      req.originalUrl,
      key,
    );
    res.setHeader('ETag', result.etag);
    return result.body;
  }

  @Post('share')
  @HttpCode(HttpStatus.OK)
  async share(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    )
    dto: ShareDetailsDto,
    @Headers('if-match') ifMatch: string | undefined,
    @IdempotencyKey() key: string | undefined,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const version = ifMatch ? parseEtag(ifMatch) : null;
    if (version === null)
      throw new AppError(
        422,
        'VALIDATION_ERROR',
        'If-Match header is required.',
      );
    const result = await this.dispatch.shareDetails(
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
}
