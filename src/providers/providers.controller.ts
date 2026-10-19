import { Body, Controller, Delete, Get, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RequestUser } from '../common/types/request-user';
import {
  ProviderAvailabilityDto,
  CreateProviderUploadDto,
  ProviderBankReviewDto,
  ProviderBankResolveDto,
  ProviderChangesReviewDto,
  ProviderBankUpdateDto,
  ProviderCalendarDto,
  ProviderListQueryDto,
  ProviderProfileSubmissionDto,
  ProviderReviewDto,
} from './dto/provider.dto';
import { ProvidersService } from './providers.service';

@ApiTags('Providers')
@Controller('providers')
@UseGuards(JwtAuthGuard)
export class ProvidersController {
  constructor(private readonly providers: ProvidersService) {}

  @Get('me')
  @ApiOperation({ summary: 'Get the signed-in provider onboarding profile' })
  myProfile(@CurrentUser() user: RequestUser) { return this.providers.myProfile(user.id); }

  @Get('banks')
  banks(@CurrentUser() user: RequestUser) { return this.providers.listBanks(user.id); }

  @Post('banks/resolve')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  resolveBank(@CurrentUser() user: RequestUser, @Body() dto: ProviderBankResolveDto) { return this.providers.resolveBankForProvider(user.id, dto); }

  @Post('me/submissions')
  @ApiOperation({ summary: 'Submit or resubmit provider onboarding details' })
  submit(@CurrentUser() user: RequestUser, @Body() dto: ProviderProfileSubmissionDto) { return this.providers.submit(user.id, dto); }

  @Post('me/uploads')
  createUpload(@CurrentUser() user: RequestUser, @Body() dto: CreateProviderUploadDto) { return this.providers.createUpload(user.id, dto); }

  @Post('me/uploads/:id/complete')
  completeUpload(@CurrentUser() user: RequestUser, @Param('id') id: string) { return this.providers.completeUpload(user.id, id); }

  @Delete('me/uploads/:id')
  deleteUpload(@CurrentUser() user: RequestUser, @Param('id') id: string) { return this.providers.deleteUpload(user.id, id); }

  @Get('me/files/:id')
  fileUrl(@CurrentUser() user: RequestUser, @Param('id') id: string) { return this.providers.fileUrl(user.id, id); }

  @Post('me/bank')
  @ApiOperation({ summary: 'Submit payout account details for review' })
  updateBank(@CurrentUser() user: RequestUser, @Body() dto: ProviderBankUpdateDto) { return this.providers.updateBank(user.id, dto); }

  @Put('me/availability')
  @ApiOperation({ summary: 'Change eligibility for new provider offers' })
  availability(@CurrentUser() user: RequestUser, @Body() dto: ProviderAvailabilityDto) { return this.providers.setAvailability(user.id, dto); }

  @Put('me/calendar')
  @ApiOperation({ summary: 'Update provider working hours and time off' })
  calendar(@CurrentUser() user: RequestUser, @Body() dto: ProviderCalendarDto) { return this.providers.setCalendar(user.id, dto); }
}

@ApiTags('Provider review')
@Controller('admin/providers')
@UseGuards(JwtAuthGuard)
export class ProviderReviewController {
  constructor(private readonly providers: ProvidersService) {}

  @Get()
  list(@CurrentUser() user: RequestUser, @Query() query: ProviderListQueryDto) { return this.providers.listForReview(user.id, query); }

  @Post(':id/reviews')
  review(@CurrentUser() user: RequestUser, @Param('id') id: string, @Body() dto: ProviderReviewDto) { return this.providers.reviewProfile(user.id, id, dto); }

  @Post(':id/changes/review')
  reviewChanges(@CurrentUser() user: RequestUser, @Param('id') id: string, @Body() dto: ProviderChangesReviewDto) { return this.providers.reviewChanges(user.id, id, dto); }

  @Post(':id/bank/review')
  reviewBank(@CurrentUser() user: RequestUser, @Param('id') id: string, @Body() dto: ProviderBankReviewDto) { return this.providers.reviewBank(user.id, id, dto); }

  @Get(':id/files/:fileId')
  fileUrl(@CurrentUser() user: RequestUser, @Param('id') id: string, @Param('fileId') fileId: string) { return this.providers.reviewFileUrl(user.id, id, fileId); }
}
