import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import type { RequestUser } from '../common/types/request-user';
import { ApprovalsService, type ApprovalFilter } from './approvals.service';

@ApiTags('Approvals')
@ApiBearerAuth()
@Controller('admin/approvals')
@UseGuards(JwtAuthGuard)
export class ApprovalsController {
  constructor(private readonly approvals: ApprovalsService) {}

  @Get()
  list(@CurrentUser() user: RequestUser, @Query('filter') filter?: ApprovalFilter, @Query('kind') kind?: string, @Query('page') page?: string) {
    return this.approvals.list(user, { filter, kind, page: page ? Number(page) : undefined });
  }

  @Get('counts')
  counts(@CurrentUser() user: RequestUser) { return this.approvals.counts(user); }
}
