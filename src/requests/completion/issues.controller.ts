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
import { IssueNoteDto, RaiseIssueDto, ResolveIssueDto } from './issues.dto';
import { IssuesService } from './issues.service';

@ApiTags('Request issues')
@ApiBearerAuth()
@Controller('requests/:id/issues')
@UseGuards(JwtAuthGuard)
export class IssuesController {
  constructor(private readonly issues: IssuesService) {}
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
    dto: RaiseIssueDto,
    @IfMatch() version: number | undefined,
    @IdempotencyKey({ required: true }) key: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.issues.raise(
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
  @Post(':iid/accept')
  async accept(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Param('iid') iid: string,
    @Body(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    )
    dto: IssueNoteDto,
    @IfMatch() version: number | undefined,
    @IdempotencyKey() key: string | undefined,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.issues.accept(
      user.id,
      id,
      iid,
      dto,
      version,
      req.originalUrl,
      key,
    );
    res.setHeader('ETag', result.etag);
    return result.body;
  }
  @Post(':iid/resolve')
  async resolve(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Param('iid') iid: string,
    @Body(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    )
    dto: ResolveIssueDto,
    @IfMatch() version: number | undefined,
    @IdempotencyKey() key: string | undefined,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.issues.resolve(
      user.id,
      id,
      iid,
      dto,
      version,
      req.originalUrl,
      key,
    );
    res.setHeader('ETag', result.etag);
    return result.body;
  }
  @Post(':iid/escalate')
  async escalate(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Param('iid') iid: string,
    @Body(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    )
    dto: IssueNoteDto,
    @IfMatch() version: number | undefined,
    @IdempotencyKey() key: string | undefined,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (!dto.note?.trim())
      throw new AppError(
        422,
        'VALIDATION_ERROR',
        'Add a note explaining the escalation.',
      );
    const result = await this.issues.escalate(
      user.id,
      id,
      iid,
      { note: dto.note },
      version,
      req.originalUrl,
      key,
    );
    res.setHeader('ETag', result.etag);
    return result.body;
  }
}
