import {
  Body,
  Controller,
  Get,
  Headers,
  Patch,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RequestUser } from '../common/types/request-user';
import {
  SavePlatformSettingsDto,
  PlatformSettingsHistoryQueryDto,
} from './dto/platform-settings.dto';
import { PlatformSettingsService } from './platform-settings.service';

@ApiTags('Platform settings')
@ApiBearerAuth()
@Controller('admin/settings')
@UseGuards(JwtAuthGuard)
export class PlatformSettingsController {
  constructor(private readonly settings: PlatformSettingsService) {}

  @Get()
  @ApiOperation({ summary: 'Read platform settings' })
  snapshot(@CurrentUser() user: RequestUser) {
    return this.settings.snapshot(user.id);
  }

  @Patch()
  @ApiOperation({ summary: 'Save platform settings' })
  save(
    @CurrentUser() user: RequestUser,
    @Body() dto: SavePlatformSettingsDto,
    @Headers('x-reauth-token') reauthToken?: string,
  ) {
    return this.settings.save(user, dto, reauthToken);
  }

  @Get('history')
  @ApiOperation({ summary: 'Read platform settings history' })
  history(
    @CurrentUser() user: RequestUser,
    @Query() query: PlatformSettingsHistoryQueryDto,
  ) {
    return this.settings.history(user.id, query);
  }
}
