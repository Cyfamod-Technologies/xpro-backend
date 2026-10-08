import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AppSurface } from '@prisma/client';
import { APP_SURFACES_KEY } from '../decorators/app-surface.decorator';
import { RequestUser } from '../types/request-user';

@Injectable()
export class AppSurfaceGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredSurfaces = this.reflector.getAllAndOverride<AppSurface[]>(
      APP_SURFACES_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!requiredSurfaces?.length) return true;

    const { user } = context.switchToHttp().getRequest<{ user: RequestUser }>();
    const allowed = requiredSurfaces.some((surface) =>
      user?.surfaces?.includes(surface),
    );

    if (!allowed) {
      throw new ForbiddenException('This account cannot access this app');
    }

    return true;
  }
}
