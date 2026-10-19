import { Injectable, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';
import { RequestContextService } from './request-context.service';

@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  constructor(private readonly ctx: RequestContextService) {}

  use(req: Request, _res: Response, next: NextFunction) {
    const forwarded = req.headers['x-forwarded-for'];
    const ipAddress =
      (Array.isArray(forwarded)
        ? forwarded[0]
        : forwarded?.split(',')[0].trim()) ??
      req.ip ??
      req.socket.remoteAddress;

    const clientHeader = req.header('X-XPro-Client');
    const client =
      clientHeader === 'web' ||
      clientHeader === 'mobile_ios' ||
      clientHeader === 'mobile_android'
        ? clientHeader
        : undefined;

    this.ctx.run(
      {
        ipAddress,
        client,
        deviceId: req.header('X-XPro-Device-Id')?.slice(0, 64),
        userAgent: req.header('user-agent')?.slice(0, 512),
      },
      next,
    );
  }
}
