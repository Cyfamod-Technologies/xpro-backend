import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { Phase2OnlyGuard } from '../common/guards/phase2-only.guard';
import { RequestUser } from '../common/types/request-user';
import {
  ListNotificationsQueryDto,
  MarkNotificationsReadDto,
} from './dto/inbox.dto';
import { InboxService } from './inbox.service';

@ApiTags('Notifications')
@Controller('notifications')
@UseGuards(Phase2OnlyGuard, JwtAuthGuard)
export class InboxController {
  constructor(private readonly inbox: InboxService) {}

  @Get()
  @ApiOperation({ summary: 'List the signed-in user’s in-app notifications' })
  list(
    @CurrentUser() user: RequestUser,
    @Query() query: ListNotificationsQueryDto,
  ) {
    return this.inbox.list(user.id, query);
  }

  @Post('read')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Mark one notification, or all of them, as read',
  })
  markRead(
    @CurrentUser() user: RequestUser,
    @Body() dto: MarkNotificationsReadDto,
  ) {
    return this.inbox.markRead(user.id, dto.notificationId);
  }
}
