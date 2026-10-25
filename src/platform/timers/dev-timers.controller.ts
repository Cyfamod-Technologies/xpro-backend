import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RequestUser } from '../../common/types/request-user';
import { PrismaService } from '../../prisma/prisma.service';
import { resolveRequestId } from '../../requests/request-ref';
import { ActorService } from '../actor/actor.service';
import { requirePermission } from '../actor/actor.guards';
import { AppError } from '../errors/app-error';
import { DevToolsGuard } from './dev-tools.guard';
import { FireTimerDto } from './dto/fire-timer.dto';
import { TimersService } from './timers.service';

@ApiTags('Dev tools')
@Controller('admin/dev/timers')
@UseGuards(DevToolsGuard, JwtAuthGuard)
export class DevTimersController {
  constructor(
    private readonly actors: ActorService,
    private readonly timers: TimersService,
    private readonly prisma: PrismaService,
  ) {}

  @Post('fire')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Make a pending timer due now (development only)',
    description:
      'Available only when ENABLE_DEV_TOOLS=true; the caller needs settings.manage.',
  })
  async fire(@CurrentUser() user: RequestUser, @Body() dto: FireTimerDto) {
    const actor = await this.actors.resolve(user.id);
    requirePermission(actor, 'settings.manage');

    const requestId = await resolveRequestId(this.prisma, dto.requestRef);
    const fired = requestId
      ? await this.timers.makeDue(requestId, dto.kind)
      : 0;
    if (fired === 0)
      // new message: not in spec
      throw new AppError(
        404,
        'NOT_FOUND',
        'No pending timer of that kind for this request.',
      );
    await this.timers.kick();
    return { fired };
  }
}
