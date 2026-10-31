import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  UseGuards,
  ValidationPipe,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import type { RequestUser } from '../common/types/request-user';
import { IdempotencyKey } from '../platform/idempotency/idempotency-key.decorator';
import { RequestGroupCreateDto } from './dto/request-group.dto';
import { RequestGroupsService } from './request-groups.service';

@ApiTags('Requests')
@ApiBearerAuth()
@Controller('request-groups')
@UseGuards(JwtAuthGuard)
export class RequestGroupsController {
  constructor(private readonly groups: RequestGroupsService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Submit several services as one project' })
  async create(
    @CurrentUser() user: RequestUser,
    @Body(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    )
    dto: RequestGroupCreateDto,
    @IdempotencyKey({ required: true }) key: string,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.groups.create(
      user,
      dto,
      key,
      request.originalUrl,
    );
    response.status(result.status);
    return result.body;
  }
}
