import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { serviceCatalogue } from './service-lines';

@ApiTags('Service catalogue')
@Controller('services')
export class CatalogController {
  @Get()
  @ApiOperation({ summary: 'List request service lines and intake fields' })
  list() {
    return serviceCatalogue;
  }
}
