import {
  Controller,
  Get,
  Body,
  HttpCode,
  HttpStatus,
  Param,
  Query,
  Res,
  UseGuards,
  ValidationPipe,
  Post,
  Put,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import type { Request } from 'express';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import type { RequestUser } from '../common/types/request-user';
import { RequestListQueryDto } from './dto/request-list-query.dto';
import { RequestActivityQueryDto } from './dto/request-activity-query.dto';
import { RequestsReadService } from './requests-read.service';
import { formatEtag } from '../platform/concurrency/etag.util';
import { IfMatch } from '../platform/concurrency/if-match.decorator';
import { IdempotencyKey } from '../platform/idempotency/idempotency-key.decorator';
import { IntakeService } from './intake.service';
import {
  RequestClarifyDto,
  RequestIntakeDto,
  RequestRejectDto,
  RequestReviewDto,
  RequestUpdateDto,
} from './dto/request-intake.dto';
import { OwnershipService } from './ownership.service';
import { CancellationService } from './cancellation/cancellation.service';
import { CancelRequestDto } from './cancellation/cancellation.dto';
import {
  RequestHandoffDto,
  RequestReassignDto,
  RequestReleaseDto,
} from './dto/request-ownership.dto';
import { MessagesService } from './messages.service';
import {
  RequestMessageQueryDto,
  SendRequestMessageDto,
} from './dto/request-message.dto';

@ApiTags('Requests')
@ApiBearerAuth()
@Controller('requests')
@UseGuards(JwtAuthGuard)
export class RequestsController {
  constructor(
    private readonly requests: RequestsReadService,
    private readonly intake: IntakeService,
    private readonly ownership: OwnershipService,
    private readonly messages: MessagesService,
    private readonly cancellation: CancellationService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Submit a service request' })
  async create(
    @CurrentUser() user: RequestUser,
    @Body(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    )
    dto: RequestIntakeDto,
    @IdempotencyKey({ required: true }) key: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.intake.create(
      user,
      dto,
      key,
      request.originalUrl,
    );
    response.status(result.status).setHeader('ETag', result.etag);
    return result.body;
  }

  @Put(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Update a request during the intake window' })
  async update(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    )
    dto: RequestUpdateDto,
    @IfMatch({ required: true }) version: number,
    @IdempotencyKey() key: string | undefined,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.intake.update(
      user,
      id,
      dto,
      version,
      request.originalUrl,
      key,
    );
    response.setHeader('ETag', result.etag);
    return result.body;
  }

  @Post(':id/clarify')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Ask the customer for intake clarification' })
  async clarify(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    )
    dto: RequestClarifyDto,
    @IfMatch() version: number | undefined,
    @IdempotencyKey() key: string | undefined,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.intake.clarify(
      user,
      id,
      dto,
      version,
      request.originalUrl,
      key,
    );
    response.setHeader('ETag', result.etag);
    return result.body;
  }

  @Post(':id/review')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Approve intake and begin provider assignment' })
  async review(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    )
    dto: RequestReviewDto,
    @IfMatch() version: number | undefined,
    @IdempotencyKey() key: string | undefined,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.intake.review(
      user,
      id,
      dto,
      version,
      request.originalUrl,
      key,
    );
    response.setHeader('ETag', result.etag);
    return result.body;
  }

  @Post(':id/reject')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reject a request during intake review' })
  async reject(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    )
    dto: RequestRejectDto,
    @IfMatch() version: number | undefined,
    @IdempotencyKey() key: string | undefined,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.intake.reject(
      user,
      id,
      dto,
      version,
      request.originalUrl,
      key,
    );
    response.setHeader('ETag', result.etag);
    return result.body;
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Cancel a request: free cancel, a cancellation request, or a staff cancel',
  })
  async cancel(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    )
    dto: CancelRequestDto,
    @IfMatch() version: number | undefined,
    @IdempotencyKey() key: string | undefined,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.cancellation.cancel(
      user,
      id,
      dto,
      version,
      request.originalUrl,
      key,
    );
    response.setHeader('ETag', result.etag);
    return result.body;
  }

  @Post(':id/claim')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Claim an unowned request' })
  async claim(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @IfMatch() version: number | undefined,
    @IdempotencyKey() key: string | undefined,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.ownership.claim(
      user,
      id,
      version,
      request.originalUrl,
      key,
    );
    response.setHeader('ETag', result.etag);
    return result.body;
  }

  @Post(':id/release')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Release request ownership to the unclaimed queue' })
  async release(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    )
    dto: RequestReleaseDto,
    @IfMatch() version: number | undefined,
    @IdempotencyKey() key: string | undefined,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.ownership.release(
      user,
      id,
      dto,
      version,
      request.originalUrl,
      key,
    );
    response.setHeader('ETag', result.etag);
    return result.body;
  }

  @Post(':id/handoff')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Hand a request to another owner' })
  async handoff(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    )
    dto: RequestHandoffDto,
    @IfMatch() version: number | undefined,
    @IdempotencyKey() key: string | undefined,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.ownership.handoff(
      user,
      id,
      dto,
      version,
      request.originalUrl,
      key,
    );
    response.setHeader('ETag', result.etag);
    return result.body;
  }

  @Post(':id/reassign')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reassign an open request to another owner' })
  async reassign(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    )
    dto: RequestReassignDto,
    @IfMatch() version: number | undefined,
    @IdempotencyKey() key: string | undefined,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.ownership.reassign(
      user,
      id,
      dto,
      version,
      request.originalUrl,
      key,
    );
    response.setHeader('ETag', result.etag);
    return result.body;
  }

  @Get()
  @ApiOperation({ summary: 'List requests visible to the signed-in account' })
  list(
    @CurrentUser() user: RequestUser,
    @Query(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    )
    query: RequestListQueryDto,
  ) {
    return this.requests.list(user, query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Read a role-filtered request detail' })
  async detail(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    const detail = await this.requests.detail(user, id);
    response.setHeader('ETag', formatEtag(detail.version));
    return detail;
  }

  @Get(':id/activity')
  @ApiOperation({ summary: 'Read activity visible to the signed-in account' })
  activity(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Query(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    )
    query: RequestActivityQueryDto,
  ) {
    return this.requests.activity(user, id, query);
  }

  @Get(':id/messages')
  @ApiOperation({
    summary: 'List messages in an available request conversation',
  })
  listMessages(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Query(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    )
    query: RequestMessageQueryDto,
  ) {
    return this.messages.list(user, id, query.channel, query.providerId);
  }

  @Post(':id/messages')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Send a message in an available request conversation',
  })
  async sendMessage(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    )
    dto: SendRequestMessageDto,
    @IfMatch() version: number | undefined,
    @IdempotencyKey() key: string | undefined,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.messages.send(
      user,
      id,
      dto,
      request.originalUrl,
      key,
      version,
    );
    response.status(result.status).setHeader('ETag', result.etag);
    return result.body;
  }
}
