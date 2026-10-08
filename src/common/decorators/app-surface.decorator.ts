import { SetMetadata } from '@nestjs/common';
import { AppSurface } from '@prisma/client';

export const APP_SURFACES_KEY = 'app_surfaces';
export const AppSurfaces = (...surfaces: AppSurface[]) =>
  SetMetadata(APP_SURFACES_KEY, surfaces);
