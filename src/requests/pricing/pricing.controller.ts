import {
  Body,
  Controller,
  Get,
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
import { IfMatch } from '../../platform/concurrency/if-match.decorator';
import { IdempotencyKey } from '../../platform/idempotency/idempotency-key.decorator';
import { PricingService } from './pricing.service';
import {
  EditQuoteDto,
  PayoutAmountDto,
  PublishQuoteDto,
  QuoteApprovalDto,
  QuoteDecisionDto,
  QuoteItemsDto,
  QuoteReturnDto,
} from './pricing.dto';

@ApiTags('Pricing and quotes')
@ApiBearerAuth()
@Controller('requests/:id')
@UseGuards(JwtAuthGuard)
export class PricingController {
  constructor(private readonly pricing: PricingService) {}

  @Get('contributions') contributions(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
  ) {
    return this.pricing.listContributions(user, id);
  }
  @Post('contributions')
  @HttpCode(HttpStatus.OK)
  async contribute(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    )
    dto: QuoteItemsDto,
    @IfMatch() version: number | undefined,
    @IdempotencyKey() key: string | undefined,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.pricing.contribute(
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
  @Get('quotes') quotes(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
  ) {
    return this.pricing.listQuotes(user, id);
  }
  @Post('quotes')
  @HttpCode(HttpStatus.CREATED)
  async createQuote(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    )
    dto: QuoteItemsDto,
    @IfMatch() version: number | undefined,
    @IdempotencyKey() key: string | undefined,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.pricing.saveQuote(
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
  @Put('quotes/:qid')
  @HttpCode(HttpStatus.OK)
  async editQuote(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Param('qid') qid: string,
    @Body(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    )
    dto: EditQuoteDto,
    @IfMatch() version: number | undefined,
    @IdempotencyKey() key: string | undefined,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.pricing.saveQuote(
      user.id,
      id,
      { ...dto, quoteId: qid },
      version,
      req.originalUrl,
      key,
    );
    res.setHeader('ETag', result.etag);
    return result.body;
  }
  @Post('quotes/:qid/publish')
  @HttpCode(HttpStatus.OK)
  async publish(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Param('qid') qid: string,
    @Body(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    )
    dto: PublishQuoteDto,
    @IfMatch() version: number | undefined,
    @IdempotencyKey() key: string | undefined,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.pricing.publish(
      user.id,
      id,
      qid,
      dto,
      version,
      req.originalUrl,
      key,
    );
    res.status(result.status).setHeader('ETag', result.etag);
    return result.body;
  }
  @Post('quotes/:qid/approve')
  @HttpCode(HttpStatus.OK)
  async approve(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Param('qid') qid: string,
    @Body(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    )
    dto: QuoteApprovalDto,
    @IfMatch() version: number | undefined,
    @IdempotencyKey() key: string | undefined,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.pricing.approve(
      user.id,
      id,
      qid,
      dto,
      version,
      req.originalUrl,
      key,
    );
    res.status(result.status).setHeader('ETag', result.etag);
    return result.body;
  }
  @Post('quotes/:qid/return')
  @HttpCode(HttpStatus.OK)
  async returnQuote(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Param('qid') qid: string,
    @Body(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    )
    dto: QuoteReturnDto,
    @IfMatch() version: number | undefined,
    @IdempotencyKey() key: string | undefined,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.pricing.returnQuote(
      user.id,
      id,
      qid,
      dto,
      version,
      req.originalUrl,
      key,
    );
    res.setHeader('ETag', result.etag);
    return result.body;
  }
  @Post('quotes/:qid/respond')
  @HttpCode(HttpStatus.OK)
  async respond(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Param('qid') qid: string,
    @Body(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    )
    dto: QuoteDecisionDto,
    @IfMatch() version: number | undefined,
    @IdempotencyKey() key: string | undefined,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.pricing.respond(
      user,
      id,
      qid,
      dto,
      version,
      req.originalUrl,
      key,
    );
    res.setHeader('ETag', result.etag);
    return result.body;
  }
  @Put('quotes/:qid/payout')
  @HttpCode(HttpStatus.OK)
  async payout(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Param('qid') qid: string,
    @Body(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    )
    dto: PayoutAmountDto,
    @IfMatch() version: number | undefined,
    @IdempotencyKey() key: string | undefined,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.pricing.setPayout(
      user.id,
      id,
      qid,
      dto.payoutAmount,
      version,
      req.originalUrl,
      key,
    );
    res.setHeader('ETag', result.etag);
    return result.body;
  }
}
