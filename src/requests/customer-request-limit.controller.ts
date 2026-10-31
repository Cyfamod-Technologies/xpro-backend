import { Body, Controller, Param, Put, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import type { RequestUser } from '../common/types/request-user';
import { CustomerRequestLimitService } from './customer-request-limit.service';
import {
  CustomerRequestLimitResponseDto,
  SetCustomerRequestLimitDto,
} from './dto/customer-request-limit.dto';

@ApiTags('Admin customers')
@ApiBearerAuth()
@Controller('admin/customers')
@UseGuards(JwtAuthGuard)
export class CustomerRequestLimitController {
  constructor(private readonly limits: CustomerRequestLimitService) {}

  @Put(':userId/request-limit')
  @ApiOperation({
    summary: "Set or clear a customer's open-request limit (account.limit)",
  })
  @ApiOkResponse({ type: CustomerRequestLimitResponseDto })
  set(
    @CurrentUser() user: RequestUser,
    @Param('userId') userId: string,
    @Body() dto: SetCustomerRequestLimitDto,
  ) {
    return this.limits.set(user, userId, dto);
  }
}
