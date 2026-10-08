import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { SuccessResponse } from '../common/decorators/response.decorator';
import { HealthService } from './health.service';

@ApiTags('Health')
@Controller()
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get('health')
  @ApiOperation({ summary: 'Health check endpoint' })
  @SuccessResponse(200, 'Health check successful')
  getHealth() {
    return this.health.getStatus();
  }
}
