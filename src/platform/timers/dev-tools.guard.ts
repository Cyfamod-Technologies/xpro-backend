import { CanActivate, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/** Hides development-only routes (404) unless `ENABLE_DEV_TOOLS=true`. Put it before the auth guard. */
@Injectable()
export class DevToolsGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(): boolean {
    if (String(this.config.get('ENABLE_DEV_TOOLS')) !== 'true')
      throw new NotFoundException();
    return true;
  }
}
