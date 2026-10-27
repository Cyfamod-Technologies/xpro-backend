import {
  Body,
  Controller,
  Header,
  Headers,
  HttpCode,
  Post,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { BootstrapAdminService } from './bootstrap-admin.service';
import { BootstrapAdminDto } from './dto/bootstrap-admin.dto';

@ApiExcludeController()
@Controller('auth/bootstrap-super-admin')
export class BootstrapAdminController {
  constructor(private readonly bootstrapAdmin: BootstrapAdminService) {}

  @Post()
  @HttpCode(201)
  @Header('Cache-Control', 'no-store')
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  bootstrap(
    @Headers('authorization') authorization: string | undefined,
    @Body() dto: BootstrapAdminDto,
  ) {
    return this.bootstrapAdmin.create(authorization, dto);
  }
}
