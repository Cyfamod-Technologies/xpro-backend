import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RequestUser } from '../../common/types/request-user';
import { LocationListQueryDto, SaveLocationDto } from './locations.dto';
import { LocationsService } from './locations.service';

@ApiTags('Locations')
@Controller()
export class LocationsController {
  constructor(private readonly locations: LocationsService) {}

  @Get('locations')
  @ApiOperation({ summary: 'List active request locations' })
  list(@Query() query: LocationListQueryDto) {
    return this.locations.list(query.parentId);
  }
}

@ApiTags('Location administration')
@Controller('admin/locations')
@UseGuards(JwtAuthGuard)
export class AdminLocationsController {
  constructor(private readonly locations: LocationsService) {}

  @Get()
  list(@CurrentUser() user: RequestUser, @Query() query: LocationListQueryDto) {
    return this.locations.adminList(user.id, query.parentId);
  }

  @Post()
  @ApiOperation({ summary: 'Create a managed location' })
  create(@CurrentUser() user: RequestUser, @Body() dto: SaveLocationDto) {
    return this.locations.save(user.id, undefined, dto);
  }

  @Put(':id')
  @ApiOperation({ summary: 'Update a managed location' })
  update(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body() dto: SaveLocationDto,
  ) {
    return this.locations.save(user.id, id, dto);
  }
}
