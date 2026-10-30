import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RequestUser } from '../common/types/request-user';
import {
  ConfirmPhoneVerificationDto,
  StartPhoneVerificationDto,
} from './dto/phone-verification.dto';
import { PhoneVerificationService } from './phone-verification.service';

@ApiTags('Phone verification')
@ApiBearerAuth()
@Controller('me/phone/verify')
@UseGuards(JwtAuthGuard)
export class PhoneController {
  constructor(private readonly verification: PhoneVerificationService) {}

  @Post('start')
  @HttpCode(202)
  @Throttle({ default: { limit: 20, ttl: 3_600_000 } })
  @ApiOperation({ summary: 'Send or resend a phone verification code' })
  start(
    @CurrentUser() user: RequestUser,
    @Body() dto: StartPhoneVerificationDto,
  ) {
    return this.verification.start(user.id, dto.phone);
  }

  @Post('confirm')
  @HttpCode(200)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({ summary: 'Verify the signed-in account phone number' })
  confirm(
    @CurrentUser() user: RequestUser,
    @Body() dto: ConfirmPhoneVerificationDto,
  ) {
    return this.verification.confirm(user.id, dto.verificationId, dto.code);
  }
}
