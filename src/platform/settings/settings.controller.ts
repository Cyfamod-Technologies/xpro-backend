import {
  Body,
  Controller,
  Get,
  Headers,
  Patch,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ActorService } from '../actor/actor.service';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RequestUser } from '../../common/types/request-user';
import { SaveSettingsDto, SettingsHistoryQueryDto } from './dto/settings.dto';
import { SettingsService } from './settings.service';

@ApiTags('Settings')
@Controller('admin/settings')
@UseGuards(JwtAuthGuard)
export class SettingsController {
  constructor(
    private readonly settings: SettingsService,
    private readonly actors: ActorService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Read request-flow settings' })
  async snapshot(@CurrentUser() user: RequestUser) {
    this.settings.assertStaff(await this.actors.resolve(user.id));
    return this.settings.snapshot();
  }

  @Patch()
  @ApiOperation({ summary: 'Save request-flow settings' })
  async save(
    @CurrentUser() user: RequestUser,
    @Body() dto: SaveSettingsDto,
    @Headers('x-reauth-token') reauthToken?: string,
  ) {
    const actor = await this.actors.resolve(user.id);
    return this.settings.save(
      actor,
      dto.changes,
      dto.reason,
      reauthToken,
      user.sid,
    );
  }

  @Get('history')
  @ApiOperation({ summary: 'Read request-flow settings history' })
  async history(
    @CurrentUser() user: RequestUser,
    @Query() query: SettingsHistoryQueryDto,
  ) {
    const actor = await this.actors.resolve(user.id);
    this.settings.assertHistoryPermission(actor);
    return this.settings.history(query);
  }
}
