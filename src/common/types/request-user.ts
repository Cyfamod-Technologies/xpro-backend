import { AppRole, AppSurface } from '@prisma/client';

export type RequestUser = {
  id: string;
  email: string;
  role: AppRole;
  sid?: string;
  surfaces: AppSurface[];
};
