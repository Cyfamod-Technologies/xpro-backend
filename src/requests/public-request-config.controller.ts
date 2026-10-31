import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { PublicRequestConfigDto } from './dto/public-request-config.dto';
import { RequestsReadService } from './requests-read.service';

@ApiTags('Requests')
@Controller('request-config')
export class PublicRequestConfigController {
  constructor(private readonly requests: RequestsReadService) {}

  @Get()
  @ApiOperation({ summary: 'Read request form limits' })
  @ApiOkResponse({ type: PublicRequestConfigDto })
  config() {
    return this.requests.publicConfig();
  }
}
