import {
  BadRequestException,
  CanActivate,
  ExecutionContext,
  Injectable,
} from '@nestjs/common';
import { Request } from 'express';

const supportedClients = new Set(['web', 'mobile_ios', 'mobile_android']);

@Injectable()
export class XProClientGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    if (request.path === '/health' || request.path === '/webhooks/paystack')
      return true;

    const client = request.header('X-XPro-Client');
    if (client && supportedClients.has(client)) return true;

    throw new BadRequestException({
      code: 'VALIDATION_ERROR',
      message: 'Update the XPro app to continue.',
    });
  }
}
