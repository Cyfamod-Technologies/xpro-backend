import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { Phase2OnlyGuard } from '../common/guards/phase2-only.guard';
import type { RequestUser } from '../common/types/request-user';
import { ApprovalsService } from './approvals.service';

@ApiTags('Approvals')
@ApiBearerAuth()
@Controller('admin/approvals')
@UseGuards(Phase2OnlyGuard, JwtAuthGuard)
export class ApprovalsController {
  constructor(private readonly approvals: ApprovalsService) {}

  @Get()
  list(
    @CurrentUser() user: RequestUser,
    @Query('filter') filter?: string,
    @Query('kind') kind?: string,
    @Query('page') page?: string,
  ) {
    return this.approvals.list(user, {
      filter,
      kind,
      page: page ? Number(page) : undefined,
    });
  }

  @Get('counts')
  counts(@CurrentUser() user: RequestUser) {
    return this.approvals.counts(user);
  }
}
