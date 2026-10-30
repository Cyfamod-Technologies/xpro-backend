import {
  Controller,
  Get,
  Query,
  Res,
  UseGuards,
  ValidationPipe,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import type { RequestUser } from '../common/types/request-user';
import { ConversationsService } from './conversations.service';
import { ConversationListQueryDto } from './dto/conversation-list-query.dto';

@ApiTags('Conversations')
@ApiBearerAuth()
@Controller('admin/conversations')
@UseGuards(JwtAuthGuard)
export class ConversationsController {
  constructor(private readonly conversations: ConversationsService) {}

  @Get()
  @ApiOperation({
    summary: 'List request conversations for the staff Messages inbox',
    description:
      'One item per request with at least one message on a channel the caller may read (`message.customer`, `message.provider`, `message.internal`), newest message first. Responds `{ data, meta }`.',
  })
  @ApiOkResponse({
    description: '`{ data: items[], meta }` (see spec 04 §11.6)',
  })
  @ApiForbiddenResponse({
    description: 'Not active staff, or no `message.*` permission (FORBIDDEN)',
  })
  @ApiUnprocessableEntityResponse({
    description: 'Unknown status, bad cursor or limit (VALIDATION_ERROR)',
  })
  async list(
    @CurrentUser() user: RequestUser,
    @Query(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
        errorHttpStatusCode: 422,
      }),
    )
    query: ConversationListQueryDto,
    // The global ResponseInterceptor wraps results as `{ data }` only, so a
    // sibling `meta` needs the response written here; the interceptor skips
    // responses that are already sent.
    @Res() response: Response,
  ) {
    response.status(200).json(await this.conversations.list(user, query));
  }
}
