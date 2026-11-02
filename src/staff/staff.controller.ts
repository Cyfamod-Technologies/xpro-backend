import {
  Body,
  Controller,
  Delete,
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
  DeactivateStaffDto,
  InviteStaffDto,
  ListStaffQueryDto,
  OwnersQueryDto,
  RenameStaffDto,
  ReactivateStaffDto,
  ResetStaffMfaDto,
  SetStaffLeaveDto,
  StaffHistoryQueryDto,
  StaffReasonDto,
  SuspendStaffDto,
  VerifyStaffMfaDto,
} from './dto/staff.dto';
import { StaffService } from './staff.service';
import { parseIfMatch } from './staff-version';

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

  @Get('summary')
  @ApiOperation({ summary: 'Counts for the staff list header' })
  summary(@CurrentUser() user: RequestUser) {
    return this.staff.summary(user.id);
  }

  @Get('owners')
  @ApiOperation({
    summary: 'Members who can take over requests, with their workload',
  })
  owners(@CurrentUser() user: RequestUser, @Query() query: OwnersQueryDto) {
    return this.staff.owners(user.id, query.exclude);
  }

  @Get(':id/history')
  @ApiOperation({ summary: 'Activity entries about one staff member' })
  history(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Query() query: StaffHistoryQueryDto,
  ) {
    return this.staff.history(user.id, id, query);
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
    @Headers('if-match') ifMatch?: string,
  ) {
    return this.staff.changeRoles(
      user.id,
      id,
      dto,
      reauthToken,
      parseIfMatch(ifMatch),
    );
  }

  @Put(':id/name')
  rename(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body() dto: RenameStaffDto,
    @Headers('if-match') ifMatch?: string,
  ) {
    return this.staff.rename(user.id, id, dto, parseIfMatch(ifMatch));
  }

  @Post(':id/suspend')
  suspend(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body() dto: SuspendStaffDto,
    @Headers('x-reauth-token') reauthToken?: string,
    @Headers('if-match') ifMatch?: string,
  ) {
    return this.staff.setStatus(
      user.id,
      id,
      'suspend',
      dto,
      reauthToken,
      parseIfMatch(ifMatch),
    );
  }

  @Post(':id/reactivate')
  reactivate(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body() dto: ReactivateStaffDto,
    @Headers('x-reauth-token') reauthToken?: string,
    @Headers('if-match') ifMatch?: string,
  ) {
    return this.staff.setStatus(
      user.id,
      id,
      'reactivate',
      dto,
      reauthToken,
      parseIfMatch(ifMatch),
    );
  }

  @Post(':id/deactivate')
  deactivate(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body() dto: DeactivateStaffDto,
    @Headers('x-reauth-token') reauthToken?: string,
    @Headers('if-match') ifMatch?: string,
  ) {
    return this.staff.setStatus(
      user.id,
      id,
      'deactivate',
      dto,
      reauthToken,
      parseIfMatch(ifMatch),
    );
  }

  @Put(':id/leave')
  setLeave(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body() dto: SetStaffLeaveDto,
    @Headers('if-match') ifMatch?: string,
  ) {
    return this.staff.setLeave(user.id, id, dto, parseIfMatch(ifMatch));
  }

  @Delete(':id/leave')
  clearLeave(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Headers('if-match') ifMatch?: string,
  ) {
    return this.staff.clearLeave(user.id, id, parseIfMatch(ifMatch));
  }

  @Post(':id/mfa/reset')
  resetMfa(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body() dto: ResetStaffMfaDto,
    @Headers('x-reauth-token') reauthToken?: string,
  ) {
    return this.staff.resetMfa(user.id, id, dto, reauthToken);
  }
}

@ApiTags('Staff invitations')
@ApiTags('Staff')
@Controller('admin/me/leave')
@UseGuards(JwtAuthGuard)
export class StaffSelfLeaveController {
  constructor(private readonly staff: StaffService) {}

  @Put()
  set(@CurrentUser() user: RequestUser, @Body() dto: SetStaffLeaveDto) {
    return this.staff.setLeave(user.id, user.id, dto);
  }

  @Delete()
  clear(@CurrentUser() user: RequestUser) {
    return this.staff.clearLeave(user.id, user.id);
  }
}

@Controller('auth/staff-invite')
export class StaffInviteController {
  constructor(private readonly staff: StaffService) {}

  @Get(':token')
  @Throttle({ default: { limit: 10, ttl: 60 * 60_000 } })
  preview(@Param('token') token: string) {
    return this.staff.invitePreview(token);
  }

  @Post('accept')
  @ApiOperation({
    summary:
      'Accept a staff invitation; authenticator setup is optional after activation',
  })
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
