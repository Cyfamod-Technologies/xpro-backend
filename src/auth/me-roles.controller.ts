import {
  Body,
  Controller,
  HttpCode,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RequestUser } from '../common/types/request-user';
import { AuthService } from './auth.service';
import { AddRoleDto, SetActiveRoleDto } from './dto/auth.dto';

@ApiTags('Auth')
@ApiBearerAuth()
@Controller('me')
@UseGuards(JwtAuthGuard)
export class MeRolesController {
  constructor(private readonly authService: AuthService) {}

  @Post('roles')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @ApiOperation({
    summary:
      'Add the customer or provider role to the signed-in account and switch to it',
  })
  addRole(@CurrentUser() user: RequestUser, @Body() dto: AddRoleDto) {
    return this.authService.addRole(user.id, dto);
  }

  @Put('active-role')
  @ApiOperation({
    summary: 'Switch between the customer and provider workspaces',
  })
  setActiveRole(
    @CurrentUser() user: RequestUser,
    @Body() dto: SetActiveRoleDto,
  ) {
    return this.authService.setActiveRole(user.id, dto.role);
  }
}
