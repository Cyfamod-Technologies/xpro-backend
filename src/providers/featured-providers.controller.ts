import { Body, Controller, Get, Put, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RequestUser } from '../common/types/request-user';
import { FeaturedProvidersUpdateDto } from './dto/featured-providers.dto';
import { FeaturedProvidersService } from './featured-providers.service';

@ApiTags('Featured providers')
@Controller('featured-providers')
export class FeaturedProvidersController {
  constructor(private readonly featured: FeaturedProvidersService) {}

  @Get()
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @ApiOperation({
    summary: 'List featured providers (public, no contact details)',
  })
  list() {
    return this.featured.publicList();
  }
}

@ApiTags('Featured providers administration')
@Controller('admin/providers/featured')
@UseGuards(JwtAuthGuard)
export class FeaturedProvidersAdminController {
  constructor(private readonly featured: FeaturedProvidersService) {}

  @Get()
  @ApiOperation({ summary: 'Get pinned, hidden and previewed featured list' })
  state(@CurrentUser() user: RequestUser) {
    return this.featured.adminState(user.id);
  }

  @Put()
  @ApiOperation({ summary: 'Replace the pinned and hidden featured lists' })
  update(
    @CurrentUser() user: RequestUser,
    @Body() dto: FeaturedProvidersUpdateDto,
  ) {
    return this.featured.updateState(user.id, dto);
  }
}
