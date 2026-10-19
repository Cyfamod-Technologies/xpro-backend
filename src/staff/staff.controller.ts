import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RequestUser } from '../common/types/request-user';
import {
  AcceptStaffInviteDto,
  ChangeStaffRolesDto,
  InviteStaffDto,
  ListStaffQueryDto,
  RenameStaffDto,
  ReactivateStaffDto,
  StaffReasonDto,
  VerifyStaffMfaDto,
} from './dto/staff.dto';
import { StaffService } from './staff.service';

@ApiTags('Staff')
@Controller('admin/staff')
@UseGuards(JwtAuthGuard)
export class StaffController {
  constructor(private readonly staff: StaffService) {}

  @Get()
  @ApiOperation({ summary: 'List staff members' })
  list(@CurrentUser() user: RequestUser, @Query() query: ListStaffQueryDto) {
    return this.staff.list(user.id, query);
  }

  @Get('permissions')
  @ApiOperation({ summary: 'Resolve the current staff member permissions' })
  myPermissions(@CurrentUser() user: RequestUser) {
    return this.staff.myPermissions(user.id);
  }

  @Get(':id')
  get(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.staff.get(user.id, id);
  }

  @Post()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  invite(
    @CurrentUser() user: RequestUser,
    @Body() dto: InviteStaffDto,
    @Headers('x-reauth-token') reauthToken?: string,
  ) {
    return this.staff.invite(user.id, dto, reauthToken);
  }

  @Post(':id/invite/resend')
  resend(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.staff.resend(user.id, id);
  }

  @Post(':id/invite/revoke')
  revoke(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body() dto: StaffReasonDto,
  ) {
    return this.staff.revoke(user.id, id, dto);
  }

  @Put(':id/roles')
  changeRoles(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body() dto: ChangeStaffRolesDto,
    @Headers('x-reauth-token') reauthToken?: string,
  ) {
    return this.staff.changeRoles(user.id, id, dto, reauthToken);
  }

  @Put(':id/name')
  rename(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body() dto: RenameStaffDto,
  ) {
    return this.staff.rename(user.id, id, dto);
  }

  @Post(':id/suspend')
  suspend(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body() dto: StaffReasonDto,
    @Headers('x-reauth-token') reauthToken?: string,
  ) {
    return this.staff.setStatus(user.id, id, 'suspend', dto, reauthToken);
  }

  @Post(':id/reactivate')
  reactivate(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body() dto: ReactivateStaffDto,
    @Headers('x-reauth-token') reauthToken?: string,
  ) {
    return this.staff.setStatus(user.id, id, 'reactivate', dto, reauthToken);
  }

  @Post(':id/deactivate')
  deactivate(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body() dto: StaffReasonDto,
    @Headers('x-reauth-token') reauthToken?: string,
  ) {
    return this.staff.setStatus(user.id, id, 'deactivate', dto, reauthToken);
  }

  @Post(':id/mfa/reset')
  resetMfa(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body() dto: StaffReasonDto,
    @Headers('x-reauth-token') reauthToken?: string,
  ) {
    return this.staff.resetMfa(user.id, id, dto, reauthToken);
  }
}

@ApiTags('Staff invitations')
@Controller('auth/staff-invite')
export class StaffInviteController {
  constructor(private readonly staff: StaffService) {}

  @Get(':token')
  @Throttle({ default: { limit: 10, ttl: 60 * 60_000 } })
  preview(@Param('token') token: string) {
    return this.staff.invitePreview(token);
  }

  @Post('accept')
  @Throttle({ default: { limit: 10, ttl: 60 * 60_000 } })
  accept(@Body() dto: AcceptStaffInviteDto) {
    return this.staff.acceptInvite(
      dto.token,
      dto.password,
      dto.policyVersion,
      dto.conflictDeclaration,
    );
  }
}

@ApiTags('Staff invitations')
@Controller('auth/mfa')
export class StaffMfaEnrollmentController {
  constructor(private readonly staff: StaffService) {}

  @Post('verify-enrollment')
  @Throttle({ default: { limit: 10, ttl: 60 * 60_000 } })
  verifyEnrollment(@Body() dto: VerifyStaffMfaDto) {
    return this.staff.verifyInviteMfa(dto.enrollmentToken, dto.code);
  }
}
