import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Query,
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
import { formatEtag } from '../platform/concurrency/etag.util';
import { IdempotencyKey } from '../platform/idempotency/idempotency-key.decorator';
import {
  V1ApproveDto,
  V1AssignStaffDto,
  V1CreateRequestDto,
  V1DenyDto,
  V1ListRequestsQueryDto,
  V1ReplaceProviderDto,
  V1SendMessageDto,
} from './v1.dto';
import { V1Service } from './v1.service';

@ApiTags('V1 request flow')
@ApiBearerAuth()
@Controller()
@UseGuards(JwtAuthGuard)
export class V1Controller {
  constructor(private readonly v1: V1Service) {}

  @Get('request-options')
  requestOptions(@CurrentUser() user: RequestUser) {
    return this.v1.requestOptions(user.id);
  }

  @Get('request-summary')
  requestSummary(@CurrentUser() user: RequestUser) {
    return this.v1.requestSummary(user.id);
  }

  @Get('requests')
  requests(
    @CurrentUser() user: RequestUser,
    @Query(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
        errorHttpStatusCode: 422,
      }),
    )
    query: V1ListRequestsQueryDto,
  ) {
    return this.v1.listRequests(user.id, query);
  }

  @Post('requests')
  @HttpCode(HttpStatus.CREATED)
  async createRequest(
    @CurrentUser() user: RequestUser,
    @Body(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    )
    dto: V1CreateRequestDto,
    @IdempotencyKey({ required: true }) key: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.v1.createRequest(user.id, dto, key, request);
    response.setHeader('ETag', formatEtag(result.version));
    return result;
  }

  @Get('requests/:id')
  async getRequest(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    const request = await this.v1.getRequest(user.id, id);
    response.setHeader('ETag', formatEtag(request.version));
    return request;
  }

  @Post('requests/:id/reassign')
  @HttpCode(HttpStatus.OK)
  async assignStaff(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    )
    dto: V1AssignStaffDto,
    @IfMatch({ required: true }) version: number,
    @IdempotencyKey({ required: true }) key: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.v1.assignStaff(
      user.id,
      id,
      dto,
      version,
      key,
      request,
    );
    response.setHeader('ETag', formatEtag(result.version));
    return result;
  }

  @Post('requests/:id/approve')
  @HttpCode(HttpStatus.OK)
  async approve(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    )
    dto: V1ApproveDto,
    @IfMatch({ required: true }) version: number,
    @IdempotencyKey({ required: true }) key: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.v1.approve(
      user.id,
      id,
      dto,
      version,
      key,
      request,
    );
    response.setHeader('ETag', formatEtag(result.version));
    return result;
  }

  @Post('requests/:id/offers/:offerId/accept')
  @HttpCode(HttpStatus.OK)
  async acceptOffer(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Param('offerId') offerId: string,
    @IfMatch({ required: true }) version: number,
    @IdempotencyKey({ required: true }) key: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.v1.acceptOffer(
      user.id,
      id,
      offerId,
      version,
      key,
      request,
    );
    response.setHeader('ETag', formatEtag(result.version));
    return result;
  }

  @Post('requests/:id/deny')
  @HttpCode(HttpStatus.OK)
  async deny(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    )
    dto: V1DenyDto,
    @IfMatch({ required: true }) version: number,
    @IdempotencyKey({ required: true }) key: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.v1.deny(user.id, id, dto, version, key, request);
    response.setHeader('ETag', formatEtag(result.version));
    return result;
  }

  @Post('requests/:id/cancel')
  @HttpCode(HttpStatus.OK)
  async cancel(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @IfMatch({ required: true }) version: number,
    @IdempotencyKey({ required: true }) key: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.v1.cancel(user.id, id, version, key, request);
    response.setHeader('ETag', formatEtag(result.version));
    return result;
  }

  @Get('requests/:id/provider-candidates')
  providerCandidates(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
  ) {
    return this.v1.providerCandidates(user.id, id);
  }

  @Put('requests/:id/provider-assignment')
  @HttpCode(HttpStatus.OK)
  async replaceProvider(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    )
    dto: V1ReplaceProviderDto,
    @IfMatch({ required: true }) version: number,
    @IdempotencyKey({ required: true }) key: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.v1.replaceProvider(
      user.id,
      id,
      dto,
      version,
      key,
      request,
    );
    response.setHeader('ETag', formatEtag(result.version));
    return result;
  }

  @Get('requests/:id/messages')
  messages(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Query('channel') channel?: string,
  ) {
    return this.v1.messages(user.id, id, channel);
  }

  @Post('requests/:id/messages')
  @HttpCode(HttpStatus.CREATED)
  sendMessage(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    )
    dto: V1SendMessageDto,
    @IdempotencyKey({ required: true }) key: string,
    @Req() request: Request,
  ) {
    return this.v1.sendMessage(user.id, id, dto, key, request);
  }

  @Get('admin/conversations')
  adminConversations(
    @CurrentUser() user: RequestUser,
    @Query('q') q?: string,
    @Query('channel') channel?: string,
  ) {
    return this.v1.adminConversations(user.id, q, channel);
  }

  @Get('me/conversations')
  customerConversations(@CurrentUser() user: RequestUser) {
    return this.v1.customerConversations(user.id);
  }

  @Get('providers/me/jobs')
  providerJobs(@CurrentUser() user: RequestUser) {
    return this.v1.providerJobs(user.id);
  }

  @Get('providers/me/jobs/:id')
  providerJob(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.v1.providerJob(user.id, id);
  }
}
